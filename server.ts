import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import pdfParse from "pdf-parse";

// Load environment variables
dotenv.config();

const app = express();
const PORT = 3000;

const ALLOWED_MODELS = ["gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash"] as const;
type AllowedModel = (typeof ALLOWED_MODELS)[number];

function resolveSelectedModel(requestedModel?: string): AllowedModel {
  if (requestedModel && (ALLOWED_MODELS as readonly string[]).includes(requestedModel)) {
    return requestedModel as AllowedModel;
  }
  return "gemini-3.1-flash-lite";
}

// Set up body parsers with generous limits for PDF base64 text
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Helper to get GoogleGenAI client (respects customKey if saved in user config, otherwise server env key)
function getGenAIClient(customKey?: string) {
  const apiKey = (customKey && customKey.trim()) || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("No se ha configurado GEMINI_API_KEY en el servidor.");
  }
  return new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// Tipos de fallo que la interfaz necesita distinguir:
// - rate_minute: 429 por límite por minuto (RPM/TPM). Se resuelve esperando.
// - quota_daily: 429 por cuota diaria agotada (o modelo sin cupo). Reintentar no sirve.
// - overloaded:  503, el modelo está saturado en Google. No es un problema de cuota.
// - other:       cualquier otro error (clave inválida, modelo inexistente, PDF inválido...).
type GeminiErrorKind = "rate_minute" | "quota_daily" | "overloaded" | "other";

interface ClassifiedGeminiError {
  kind: GeminiErrorKind;
  httpStatus: number | null;
  apiStatus: string;
  message: string;
  retryAfterSeconds: number | null;
}

function classifyGeminiError(error: any): ClassifiedGeminiError {
  const rawMessage = String(error?.message ?? error ?? "");

  let httpStatus: number | null =
    typeof error?.status === "number" ? error.status : typeof error?.code === "number" ? error.code : null;
  let apiStatus = typeof error?.status === "string" ? error.status : "";
  let message = rawMessage;
  let details: any[] = [];

  // El SDK suele incluir el cuerpo JSON de la respuesta de Google dentro del mensaje
  const jsonStart = rawMessage.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(rawMessage.slice(jsonStart));
      const body = parsed?.error ?? parsed;
      if (typeof body?.code === "number" && httpStatus === null) httpStatus = body.code;
      if (typeof body?.status === "string") apiStatus = body.status;
      if (typeof body?.message === "string" && body.message.trim()) message = body.message;
      if (Array.isArray(body?.details)) details = body.details;
    } catch {
      // El mensaje no era JSON; se usa tal cual
    }
  }

  const isQuota = httpStatus === 429 || apiStatus === "RESOURCE_EXHAUSTED";
  const isOverloaded = httpStatus === 503 || apiStatus === "UNAVAILABLE";

  let retryAfterSeconds: number | null = null;
  const retryInfo = details.find((d) => typeof d?.retryDelay === "string");
  const retryMatch =
    (retryInfo ? String(retryInfo.retryDelay).match(/([\d.]+)s/) : null) ||
    message.match(/retry in ([\d.]+)\s*s/i);
  if (retryMatch) {
    const parsedSeconds = parseFloat(retryMatch[1]);
    if (!isNaN(parsedSeconds)) retryAfterSeconds = Math.ceil(parsedSeconds);
  }

  let kind: GeminiErrorKind = "other";
  if (isQuota) {
    const quotaText = `${message} ${JSON.stringify(details)}`;
    const isDaily = /per\s*day|daily/i.test(quotaText) || /limit:\s*0\b/i.test(quotaText);
    kind = isDaily ? "quota_daily" : "rate_minute";
  } else if (isOverloaded) {
    kind = "overloaded";
  }

  return { kind, httpStatus, apiStatus, message: message.trim(), retryAfterSeconds };
}

function parseSpacedNumber(raw: any): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === "number") return raw;
  const str = String(raw).trim();
  if (/^[\d][\s\d\.]+$/.test(str)) {
    return parseInt(str.replace(/\s+/g, "").replace(/\./g, ""), 10) || 0;
  }
  return parseInt(str.replace(/\./g, "").replace(/,/g, ""), 10) || 0;
}

// Pre-clean spaced cell digits inside pdf-parse text locally (zero extra API tokens!)
function normalizeSpacedDigitsInText(rawText: string): string {
  if (!rawText) return "";
  return rawText.replace(/\b(\d(?:\s+[\d\.]){2,})\b/g, (match) => {
    const joined = match.replace(/[\s\.]+/g, "");
    return `${joined}`;
  });
}

// Endpoint to process a Tax Form with the user-selected model
app.post("/api/process-form", async (req, res) => {
  const {
    pdfBase64,
    fileName,
    customApiKey,
    model = "gemini-3.1-flash-lite",
  } = req.body;

  const selectedModel = resolveSelectedModel(model);
  const keySource: "custom" | "aistudio" =
    typeof customApiKey === "string" && customApiKey.trim() ? "custom" : "aistudio";
  // Peticiones realmente enviadas a Gemini en esta llamada (0 si falló antes de enviar)
  let apiCalls = 0;

  if (!pdfBase64) {
    return res.status(400).json({ error: "Falta el archivo PDF en base64." });
  }

  // ----------------------------------------------------
  // PRE-PROCESAMIENTO LOCAL (pdf-parse + Limpieza de Celdas)
  // No es OCR: solo lee la capa de texto de PDFs digitales y une dígitos espaciados.
  // En PDFs escaneados no devuelve nada y Gemini lee el documento visualmente.
  // ----------------------------------------------------
  let ocrText = "";
  let isScannedPdf = true;
  try {
    const buffer = Buffer.from(pdfBase64, "base64");
    const pdfData = await pdfParse(buffer);
    const rawText = (pdfData.text || "").trim();
    isScannedPdf = rawText.replace(/\s+/g, "").length < 100;
    ocrText = normalizeSpacedDigitsInText(rawText);
  } catch {
    // Si falla pdf-parse, se procesa visualmente como PDF escaneado
  }

  try {
    const ai = getGenAIClient(customApiKey);

    const pdfPart = {
      inlineData: {
        mimeType: "application/pdf",
        data: pdfBase64,
      },
    };

    const promptText = `
Eres un auditor fiscal en Colombia. Analiza este formulario de impuestos (ReteICA, ICA, etc.).
Devuelve obligatoriamente un JSON que contiene los datos solicitados basándote estrictamente en el formulario.

Información del archivo original de referencia:
- Nombre de archivo: "${fileName}"
- Tipo de documento detectado: ${isScannedPdf ? "PDF Escaneado / Imagen (Aplica lectura visual de tabla renglón por renglón)" : "PDF con capa de texto digital normalizada"}

${
  ocrText.trim()
    ? `
--- TEXTO DE LA CAPA DIGITAL DEL PDF (EXTRAÍDO Y NORMALIZADO LOCALMENTE) ---
Utiliza este texto como capa de anclaje para corroborar los valores que ves en el PDF visual:
${ocrText.substring(0, 8000)}
-------------------------------------------------------
`
    : ""
}

Pautas estrictas de extracción:
1. total_a_pagar: ¡PRIORIDAD MÁXIMA! Identifica el valor real de la obligación tributaria final a pagar.
   - Regla 1: Prioriza el valor asociado al campo final de pago (ej. 'TOTAL PAGO', 'TOTAL PAGADO', 'TOTAL A PAGAR', 'Total a Pagar', 'Total valor a Pagar', 'Total Retenciones ($)'), no otros totales parciales, bases, anticipos, saldos anteriores o valores acumulados.
   - Regla 2: Busca en la zona inferior o de resumen del formulario y asocia la etiqueta y número de renglón más cercano al valor numérico final.
   - Regla 3: Si "TOTAL A PAGAR" o "VALOR A PAGAR" figura en cero (0), busca apartados como "TOTAL SALDO A CARGO", "TOTAL RETENCIONES MÁS SANCIONES" o "TOTAL RETENCIONES PRACTICADAS" que reflejen el valor retenido declarado, y utiliza ese valor como el monto real.
   - Regla 4: ¡ALERTA DE ERROR COMÚN!: NO confundas la "Base Gravable", "Base de Retención", o "Total Ingresos" con el valor a pagar. La Base siempre es mucho mayor y se usa para calcular el impuesto (TARIFA * BASE = IMPUESTO).
   - Regla 5: Algunos PDFs tienen dígitos separados por espacios porque cada celda del formulario PDF es un carácter independiente (ej: "6 8 0 0 0" = 68000, "2 6 . 0 0 0" = 26000). Une SIEMPRE esos dígitos antes de retornar el JSON como entero sin puntos ni comas.
   - Regla 6: Si el documento indica claramente una declaración en ceros confirmada y explícita, devuelve 0. En cualquier otro caso incierto o ilegible, devuelve null y baja confianza.
2. tipo_impuesto: Identifica si es 'ICA' o 'RETEICA'. El nombre del archivo "${fileName}" suele indicarlo explícitamente.
3. periodo: Extrae el Periodo fiscal declarado (mes/bimestre y año, ej. "Bimestre 5 2026", "Abril 2025").
4. municipio: Extrae el nombre del municipio o ciudad correspondiente (ej. San Alberto, Medellín, Bogotá, Envigado).
`;

    // Una sola llamada por petición. Las esperas y reintentos los decide el cliente
    // según el tipo de error real que devuelva Google.
    apiCalls = 1;
    const response = await ai.models.generateContent({
      model: selectedModel,
      contents: [pdfPart, { text: promptText }],
      config: {
        systemInstruction:
          "Eres un auditor fiscal experto de primer nivel en tributación territorial de Colombia. Debes extraer datos de formularios con precisión matemática.",
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            municipio: {
              type: Type.STRING,
              description: "Nombre de la ciudad o municipio del formulario de impuestos (ej. Bogotá, Medellín, San Alberto).",
            },
            tipo_impuesto: {
              type: Type.STRING,
              description: "Escribe estrictamente 'ICA' o 'RETEICA' según corresponda.",
            },
            nit: {
              type: Type.STRING,
              description: "NIT del contribuyente, por ejemplo 900123456-7.",
            },
            contribuyente: {
              type: Type.STRING,
              description: "Razón social o nombre completo del declarante.",
            },
            periodo: {
              type: Type.STRING,
              description: "Mes/Bimestre y año de declaración, por ejemplo 'Bimestre 5 2026' o 'Abril 2025'.",
            },
            base_gravable: {
              type: Type.INTEGER,
              description: "Base gravable total declarada. Null si no es legible.",
              nullable: true,
            },
            tarifa: {
              type: Type.NUMBER,
              description: "Tarifa aplicable. Null si no es legible.",
              nullable: true,
            },
            valor_declarado_por_impuestos: {
              type: Type.INTEGER,
              description: "Valor neto del impuesto sin sanciones ni recargos. Null si no es legible.",
              nullable: true,
            },
            intereses_o_sanciones: {
              type: Type.INTEGER,
              description: "Sanciones, intereses de mora o recargos, si los hay. Null si no hay o no es legible.",
              nullable: true,
            },
            total_saldo_a_cargo: {
              type: Type.INTEGER,
              description: "Monto del renglón 'TOTAL SALDO A CARGO'. Especialmente útil cuando 'TOTAL A PAGAR' aparece en 0.",
              nullable: true,
            },
            total_a_pagar: {
              type: Type.INTEGER,
              description:
                "Monto real de la obligación final. Si el 'Total a Pagar' es 0 pero hay un 'Total Saldo a Cargo' o 'Total Retenciones', extrae ese valor mayor a cero.",
              nullable: true,
            },
            confianza_extraccion: {
              type: Type.NUMBER,
              description:
                "Escala 0-1. Nivel de confianza en la extracción del campo 'total_a_pagar'. Si hay dudas, asigna un valor menor a 0.85.",
              nullable: true,
            },
            etiqueta_detectada: {
              type: Type.STRING,
              description:
                "La etiqueta exacta (ej. 'TOTAL PAGO', 'Total a Pagar') que usaste para extraer el valor de 'total_a_pagar'.",
              nullable: true,
            },
            motivo_revision: {
              type: Type.STRING,
              description:
                "Si la confianza es menor a 0.85 o el valor es null, explica brevemente el motivo.",
              nullable: true,
            },
          },
          required: ["municipio", "tipo_impuesto", "periodo"],
        },
      },
    });

    const textOutput = response.text || "{}";
    const data = JSON.parse(textOutput);
    data.metodo_usado = `Gemini (${selectedModel})`;

    if (data.total_a_pagar !== undefined && data.total_a_pagar !== null) {
      data.total_a_pagar = parseSpacedNumber(data.total_a_pagar);
    }
    if (data.base_gravable !== undefined && data.base_gravable !== null) {
      data.base_gravable = parseSpacedNumber(data.base_gravable);
    }
    if (data.total_saldo_a_cargo !== undefined && data.total_saldo_a_cargo !== null) {
      data.total_saldo_a_cargo = parseSpacedNumber(data.total_saldo_a_cargo);
    }
    if (data.valor_declarado_por_impuestos !== undefined && data.valor_declarado_por_impuestos !== null) {
      data.valor_declarado_por_impuestos = parseSpacedNumber(data.valor_declarado_por_impuestos);
    }

    if (!data.total_a_pagar) {
      if (data.total_saldo_a_cargo && data.total_saldo_a_cargo > 0) {
        data.total_a_pagar = data.total_saldo_a_cargo;
      } else if (data.valor_declarado_por_impuestos && data.valor_declarado_por_impuestos > 0) {
        data.total_a_pagar = data.valor_declarado_por_impuestos;
      }
    }

    if (
      data.total_a_pagar &&
      data.total_a_pagar > 500000 &&
      data.base_gravable &&
      data.total_a_pagar > data.base_gravable
    ) {
      data.confianza_extraccion = 0.3;
      data.motivo_revision = "total_a_pagar supera base_gravable, posible confusión de campos";
    }

    return res.json({
      success: true,
      fileName,
      data,
      model: selectedModel,
      keySource,
      apiCalls,
    });
  } catch (error: any) {
    const classified = classifyGeminiError(error);
    console.error(
      `[${selectedModel}] Error de Gemini (${classified.kind}, HTTP ${classified.httpStatus ?? "?"} ${classified.apiStatus}): ${classified.message}`
    );

    // Se responde 200 con success:false para que ningún intermediario reintente o
    // reemplace el cuerpo: el cliente necesita el tipo de error y el mensaje real.
    return res.json({
      success: false,
      fileName,
      model: selectedModel,
      keySource,
      apiCalls,
      errorKind: classified.kind,
      httpStatus: classified.httpStatus,
      apiStatus: classified.apiStatus,
      retryAfterSeconds: classified.retryAfterSeconds,
      error: classified.message || "Error interno del servidor al procesar el impuesto con IA.",
    });
  }
});

// Serve health status
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", message: "Audit Server Live", allowedModels: ALLOWED_MODELS });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    console.log("Configuring Vite Dev Server Middleware...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Serving built static files in production...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[TAX_AUDITOR_SERVER] Running on http://localhost:${PORT}`);
  });
}

startServer();
