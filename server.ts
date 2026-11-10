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

function isQuotaOrTransientError(error: any): { isTransient: boolean; retrySeconds: number | null } {
  const errorStr =
    (error?.message || "").toString() +
    " " +
    String(error) +
    " " +
    (typeof error === "object" ? JSON.stringify(error) : "");

  const isTransient =
    error?.status === 429 ||
    error?.code === 429 ||
    error?.status === 503 ||
    error?.code === 503 ||
    errorStr.includes("429") ||
    errorStr.includes("503") ||
    errorStr.toLowerCase().includes("quota") ||
    errorStr.includes("RESOURCE_EXHAUSTED") ||
    errorStr.includes("UNAVAILABLE") ||
    errorStr.toLowerCase().includes("high demand");

  let retrySeconds: number | null = null;
  const match = errorStr.match(/retry in ([\d\.]+)s/i) || errorStr.match(/"retryDelay"\s*:\s*"(\d+)s"/i);
  if (match) {
    retrySeconds = parseFloat(match[1]);
  }

  return { isTransient, retrySeconds };
}

// Call the user-selected model with automatic wait and retry on temporary RPM limits (never switches to another model)
async function generateContentWithSelectedModel(
  ai: GoogleGenAI,
  selectedModel: AllowedModel,
  contents: any,
  config: any,
  maxRetries = 3
): Promise<{ response: any; requestsUsed: number; hadRateLimitWait: boolean }> {
  let baseDelaySec = 6;
  let requestsUsed = 0;
  let hadRateLimitWait = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    requestsUsed++;
    try {
      const response = await ai.models.generateContent({
        model: selectedModel,
        contents,
        config,
      });
      return { response, requestsUsed, hadRateLimitWait };
    } catch (error: any) {
      const { isTransient, retrySeconds } = isQuotaOrTransientError(error);
      if (isTransient && attempt < maxRetries) {
        hadRateLimitWait = true;
        const waitSec = retrySeconds
          ? Math.min(Math.ceil(retrySeconds) + 1.5, 26)
          : Math.min(baseDelaySec, 20);
        console.log(
          `[${selectedModel}] Límite temporal por minuto detectado. Esperando ${waitSec.toFixed(1)}s antes del reintento ${attempt + 1}/${maxRetries} en ${selectedModel}...`
        );
        await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
        baseDelaySec = Math.round(baseDelaySec * 1.6);
      } else {
        (error as any).requestsUsed = requestsUsed;
        throw error;
      }
    }
  }

  throw new Error(`No se pudo completar la consulta en ${selectedModel} tras varios reintentos.`);
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

// Function to safely extract Colombian tax fields dynamically if Cloud API is completely unreachable
function parseColombianTaxFormFallback(pdfBase64: string, fileName: string, nativeText = "") {
  let pdfText = nativeText;
  try {
    const buffer = Buffer.from(pdfBase64, "base64");
    const raw = buffer.toString("binary");
    const parenMatches = raw.match(/\(([^)]+)\)/g);
    let resolvedText = "";
    if (parenMatches) {
      resolvedText = parenMatches.map((m) => m.slice(1, -1)).join(" ");
    }
    const printable = raw.replace(/[^\x20-\x7E]/g, " ");
    pdfText = (nativeText + " " + resolvedText + " " + printable).replace(/\s+/g, " ");
  } catch {
    // Ignore binary fallback errors
  }

  const normalizedText = pdfText.toLowerCase() + " " + fileName.toLowerCase();

  let nit = "";
  const fnNitMatch = fileName.match(/^(\d{7,10}(?:-\d)?)/) || fileName.match(/(\d{8,10}-\d|\d{8,10})/);
  if (fnNitMatch) {
    nit = fnNitMatch[1];
  } else {
    const nitRegexes = [
      /nit[:\s]+(\d+[\.\d]*\-\d|\d{9,11})/gi,
      /n\.i\.t\.?[:\s]+(\d+[\.\d]*\-\d|\d{9,11})/gi,
      /(\d{9,10}-\d)/g,
    ];
    for (const regex of nitRegexes) {
      const match = pdfText.match(regex);
      if (match) {
        nit = match[0].replace(/nit|n\.i\.t\.?:?/gi, "").trim();
        break;
      }
    }
  }

  nit = nit.replace(/[^\d\-]/g, "").trim();
  if (!nit || nit.length < 5) {
    nit = "800.000.000-0";
  }

  let tipo_impuesto = "ICA";
  if (
    normalizedText.includes("reteica") ||
    normalizedText.includes("rete-ica") ||
    normalizedText.includes("rete_ica") ||
    normalizedText.includes("rete ica") ||
    normalizedText.includes("retención") ||
    normalizedText.includes("retencion")
  ) {
    tipo_impuesto = "RETEICA";
  }

  let periodo = "";
  const fnPeriodMatch = fileName.match(
    /(bim\s*\d\s*20\d\d|bimestre\s*\d\s*20\d\d|(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)[a-z]*\s*20\d\d)/i
  );
  if (fnPeriodMatch) {
    periodo = fnPeriodMatch[1].replace(/\s+/g, " ").trim();
  } else {
    const bimonthlyMatch = pdfText.match(
      /(bimestre\s+[1-6]\s+(de\s+)?20\d\d|bim\s+[1-6]\s+20\d\d|periodo\s+[1-6]\s+20\d\d)/gi
    );
    if (bimonthlyMatch) {
      periodo = bimonthlyMatch[0].trim();
    } else {
      const yearMatch = normalizedText.match(/(202\d|203\d)/);
      const year = yearMatch ? yearMatch[1] : "2026";
      periodo = `Periodo ${year}`;
    }
  }

  let municipio = "BOGOTÁ";
  const colombianCities = [
    "SAN ALBERTO", "PUERTO CARRENO", "PUERTO CARREÑO", "SANTA MARTA", "VILLAVICENCIO",
    "BARRANQUILLA", "BUCARAMANGA", "CARTAGENA", "MEDELLIN", "BOGOTA", "CALI", "SOACHA",
    "ENVIGADO", "SABANETA", "ITAGUI", "BELLO", "CHIBOLO", "TOCAIMA", "MANIZALES",
    "PEREIRA", "ARMENIA", "CUCUTA", "IBAGUE", "NEIVA", "POPAYAN", "PASTO", "VALLEDUPAR",
    "MONTERIA", "SINCELEJO", "RIOHACHA", "YOPAL", "FLORENCIA", "MOCOA", "LETICIA",
    "MITU", "INIRIDA", "TUNJA", "QUIBDO", "FACATATIVA", "CHIA", "SOPO", "ZIPAQUIRA",
    "FUNZA", "MOSQUERA", "MADRID", "CAJICA", "TOCANCIPA", "LA PAZ",
  ];

  for (const city of colombianCities) {
    if (normalizedText.includes(city.toLowerCase())) {
      municipio = city;
      break;
    }
  }

  const cleanFN = fileName
    .replace(/\.[^/.]+$/, "")
    .replace(/\(extraído de.*$/i, "")
    .replace(/_/g, " ");
  const parts = cleanFN.split(/\s+/);
  const stopWords = [
    "rete", "ica", "reteica", "bim", "periodo", "bimestre", "año", "ano",
    "declaracion", "retencion", "de", "del", "2024", "2025", "2026", "2027", "2028",
  ];
  const municipioParts: string[] = [];

  for (const part of parts) {
    const partLower = part.toLowerCase();
    if (/^[\d\-]+$/.test(part)) continue;
    if (stopWords.includes(partLower)) continue;
    if (partLower.includes("rete") || partLower.includes("ica")) continue;
    municipioParts.push(part);
  }

  if (municipioParts.length > 0 && municipio === "BOGOTÁ" && !normalizedText.includes("bogota")) {
    municipio = municipioParts.slice(0, 2).join(" ").toUpperCase();
  }

  const contribuyente = "CONTRIBUYENTE DECLARANTE";

  let total_a_pagar: number | null = null;
  const paymentKeywords = [
    "total a pagar",
    "valor a pagar",
    "total saldo a cargo",
    "total retenciones",
    "pago total",
  ];
  let bestNumber = 0;

  for (const keyword of paymentKeywords) {
    const escapedKeyword = keyword.replace(/\s+/g, "\\s+");
    const regex = new RegExp(`${escapedKeyword}[:\\s$]*([\\d\\.,]+)`, "i");
    const match = pdfText.match(regex);
    if (match) {
      const parsedNum = parseInt(match[1].replace(/[\.,]/g, ""), 10);
      if (!isNaN(parsedNum) && parsedNum > bestNumber) {
        bestNumber = parsedNum;
      }
    }
  }

  if (bestNumber > 0) {
    total_a_pagar = bestNumber;
  }

  return {
    municipio: municipio.toUpperCase(),
    tipo_impuesto: tipo_impuesto as "ICA" | "RETEICA" | "DESCONOCIDO",
    nit: nit,
    contribuyente: contribuyente,
    periodo: periodo.toUpperCase(),
    total_a_pagar: total_a_pagar,
    confianza_extraccion: 0.4,
    etiqueta_detectada: "N/A (Extracción Local)",
    motivo_revision: "Límite de cuota de la API persistente tras reintentos. Verificar cifra en el PDF.",
    metodo_usado: "Respaldo Local (Cuota API)",
    isFallback: true,
  };
}

// Endpoint to process a Tax Form with the user-selected model
app.post("/api/process-form", async (req, res) => {
  const {
    pdfBase64,
    fileName,
    customApiKey,
    model = "gemini-3.1-flash-lite",
    pipeline = "hybrid_markdown_ocr",
  } = req.body;

  const selectedModel = resolveSelectedModel(model);

  if (!pdfBase64) {
    return res.status(400).json({ error: "Falta el archivo PDF en base64." });
  }

  // ----------------------------------------------------
  // PRE-PROCESAMIENTO OCR LOCAL (pdf-parse + Limpieza de Celdas)
  // Cero consumo de cuota API: extrae texto y une dígitos espaciados localmente
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
--- TEXTO EXTRAÍDO Y NORMALIZADO MEDIANTE OCR LOCAL ---
Utiliza este texto estructurado como capa de anclaje para corroborar los valores que ves en el PDF visual:
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

    const { response, requestsUsed, hadRateLimitWait } = await generateContentWithSelectedModel(
      ai,
      selectedModel,
      [pdfPart, { text: promptText }],
      {
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
      }
    );

    const textOutput = response.text || "{}";
    const data = JSON.parse(textOutput);
    data.metodo_usado =
      pipeline === "hybrid_markdown_ocr"
        ? `Pipeline Híbrido (${selectedModel})`
        : `LLM (${selectedModel})`;

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
      quotaMetrics: {
        requestsUsed,
        model: selectedModel,
        hadRateLimitWait,
      },
    });
  } catch (error: any) {
    const { isTransient } = isQuotaOrTransientError(error);
    const failedRequestsUsed = error?.requestsUsed || 1;

    if (isTransient) {
      const fallbackData = parseColombianTaxFormFallback(pdfBase64, fileName, ocrText);
      return res.json({
        success: true,
        fileName,
        data: fallbackData,
        quotaMetrics: {
          requestsUsed: failedRequestsUsed,
          model: selectedModel,
          hadRateLimitWait: true,
        },
        fallbackInfo:
          "Extraído localmente de forma segura debido a saturación persistente de cuota de la API.",
      });
    }

    return res.status(500).json({
      success: false,
      quotaMetrics: {
        requestsUsed: failedRequestsUsed,
        model: selectedModel,
        hadRateLimitWait: false,
      },
      error: error.message || "Error interno del servidor al procesar el impuesto con IA.",
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
