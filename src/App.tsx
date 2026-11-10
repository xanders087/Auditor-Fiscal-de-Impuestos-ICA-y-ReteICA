import React, { useState, useRef, useEffect } from "react";
import {
  FileText,
  UploadCloud,
  XCircle,
  AlertCircle,
  CheckCircle2,
  Settings,
  Database,
  Trash2,
  Play,
  Loader2,
  Search,
  RotateCcw,
} from "lucide-react";
import { TaxEntry, Configuration, FileItem } from "./types";
import { exportToExcel } from "./utils/excelExport";
import JSZip from "jszip";

// Helper to format values to Colombian Pesos format
export function formatColombianPesos(val: number): string {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(val);
}

// Contador local de peticiones enviadas hoy, por modelo. Es solo informativo:
// la cuota real la define Google por proyecto y se consulta en el panel de AI Studio.
interface RequestCounterState {
  date: string; // YYYY-MM-DD
  counts: Record<string, number>;
}

type ApiStatusKind = "idle" | "ok" | "rate_minute" | "overloaded" | "quota_daily" | "other";

// Último resultado real devuelto por la API de Gemini
interface ApiStatus {
  kind: ApiStatusKind;
  model?: string;
  keySource?: "custom" | "aistudio";
  httpStatus?: number | null;
  message?: string;
}

interface WaitState {
  seconds: number;
  reason: "pacing" | "rate_minute" | "overloaded";
}

const PACING_SECONDS = 12;
const MAX_RETRIES_PER_FILE = 3;

function getTodayDateString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export default function App() {
  // ----- State management -----
  const [entries, setEntries] = useState<TaxEntry[]>(() => {
    const saved = localStorage.getItem("tax_audits_entries");
    return saved ? JSON.parse(saved) : [];
  });

  const [config, setConfig] = useState<Configuration>(() => {
    const saved = localStorage.getItem("tax_audits_config");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        const validModels = ["gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash"];
        const resolvedModel = validModels.includes(parsed.model)
          ? parsed.model
          : "gemini-3.1-flash-lite";
        return {
          provider: "gemini",
          model: resolvedModel,
          apiKey: parsed.apiKey || "",
        };
      } catch {
        // Fallback default
      }
    }
    return {
      provider: "gemini",
      model: "gemini-3.1-flash-lite",
      apiKey: "",
    };
  });

  const [requestCounter, setRequestCounter] = useState<RequestCounterState>(() => {
    const today = getTodayDateString();
    const saved = localStorage.getItem("tax_audits_request_counter");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.date === today && parsed.counts && typeof parsed.counts === "object") {
          return { date: today, counts: parsed.counts };
        }
      } catch {
        // Ignore parse error
      }
    }
    return { date: today, counts: {} };
  });

  const [apiStatus, setApiStatus] = useState<ApiStatus>({ kind: "idle" });
  const [waitState, setWaitState] = useState<WaitState | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<"ALL" | "ICA" | "RETEICA">("ALL");
  const [dragActive, setDragActive] = useState(false);
  const [fileQueue, setFileQueue] = useState<FileItem[]>([]);
  const [isProcessingBatch, setIsProcessingBatch] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const cancelBatchRef = useRef(false);
  const [batchProgress, setBatchProgress] = useState(0);
  const [showConfig, setShowConfig] = useState(false);
  const [noticeBanner, setNoticeBanner] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  // Input file Ref
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Save entries to localStorage
  useEffect(() => {
    localStorage.setItem("tax_audits_entries", JSON.stringify(entries));
  }, [entries]);

  // Save config to localStorage
  useEffect(() => {
    localStorage.setItem("tax_audits_config", JSON.stringify(config));
  }, [config]);

  // Save request counter to localStorage
  useEffect(() => {
    localStorage.setItem("tax_audits_request_counter", JSON.stringify(requestCounter));
  }, [requestCounter]);

  // Count requests actually sent to Gemini today, per model
  const recordApiRequests = (model: string, count: number) => {
    if (count <= 0) return;
    const today = getTodayDateString();
    setRequestCounter((prev) => {
      const counts = prev.date === today ? prev.counts : {};
      return { date: today, counts: { ...counts, [model]: (counts[model] || 0) + count } };
    });
  };

  const resetRequestCounter = () => {
    setRequestCounter({ date: getTodayDateString(), counts: {} });
  };

  const requestsTodayForModel =
    requestCounter.date === getTodayDateString() ? requestCounter.counts[config.model] || 0 : 0;
  const hasCustomKey = Boolean(config.apiKey && config.apiKey.trim());

  // Visible countdown; returns false if the batch was cancelled while waiting
  const waitWithCountdown = async (seconds: number, reason: WaitState["reason"]): Promise<boolean> => {
    let remaining = Math.max(1, Math.ceil(seconds));
    setWaitState({ seconds: remaining, reason });
    while (remaining > 0) {
      if (cancelBatchRef.current) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      remaining--;
      if (remaining > 0) setWaitState({ seconds: remaining, reason });
    }
    setWaitState(null);
    return !cancelBatchRef.current;
  };

  // Handle Drag Over events
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  // Convert File to Base64 helper
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const resultStr = reader.result as string;
        const base64 = resultStr.split(",")[1];
        resolve(base64);
      };
      reader.onerror = (error) => reject(error);
    });
  };

  // Process uploaded or dropped files
  const processFiles = async (filesList: FileList | File[]) => {
    setNoticeBanner(null);
    const newFileItems: FileItem[] = [];

    for (let i = 0; i < filesList.length; i++) {
      const file = filesList[i];
      const name = file.name.toLowerCase();

      if (name.endsWith(".pdf")) {
        newFileItems.push({
          id: `file-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
          file: file,
          name: file.name,
          size: file.size,
          status: "pending",
          progress: 0,
        });
      } else if (name.endsWith(".zip")) {
        try {
          const zip = new JSZip();
          const loadedZip = await zip.loadAsync(file);
          const zipFiles: File[] = [];

          const fileKeys = Object.keys(loadedZip.files);
          for (const key of fileKeys) {
            const zipEntry = loadedZip.files[key];
            if (!zipEntry.dir && key.toLowerCase().endsWith(".pdf")) {
              const fileData = await zipEntry.async("blob");
              const simpleName = key.split("/").pop() || key;
              const extractedFile = new File([fileData], simpleName, {
                type: "application/pdf",
              });
              zipFiles.push(extractedFile);
            }
          }

          if (zipFiles.length === 0) {
            setNoticeBanner(`No se encontraron archivos PDF dentro de ${file.name}`);
            continue;
          }

          zipFiles.forEach((f) => {
            newFileItems.push({
              id: `file-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
              file: f,
              name: `${f.name} (extraído de ${file.name})`,
              size: f.size,
              status: "pending",
              progress: 0,
            });
          });
        } catch (err: any) {
          setNoticeBanner(`Error al descomprimir ZIP: ${err.message}`);
        }
      } else {
        setNoticeBanner(`Formato no soportado: ${file.name}. Suba archivos .pdf o paquetes .zip`);
      }
    }

    if (newFileItems.length > 0) {
      setFileQueue((prev) => [...prev, ...newFileItems]);
    }
  };

  // Drop Event handler
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await processFiles(e.dataTransfer.files);
    }
  };

  // File picker handler
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await processFiles(e.target.files);
      e.target.value = "";
    }
  };

  // Trigger file dialog
  const onButtonClick = () => {
    fileInputRef.current?.click();
  };

  // Cancel active batch processing safely
  const cancelBatchProcessing = () => {
    setIsCancelling(true);
    cancelBatchRef.current = true;
  };

  // Run the batch processing queue
  const runBatchProcessing = async () => {
    if (fileQueue.length === 0 || isProcessingBatch) return;

    const pendingFiles = fileQueue.filter((item) => item.status === "pending" || item.status === "error");
    if (pendingFiles.length === 0) return;

    setIsProcessingBatch(true);
    setIsCancelling(false);
    cancelBatchRef.current = false;
    setBatchProgress(0);

    const totalToProcess = pendingFiles.length;
    let completedCount = 0;
    let dailyQuotaHit = false;

    const setItem = (id: string, patch: Partial<FileItem>) =>
      setFileQueue((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));

    for (let i = 0; i < pendingFiles.length; i++) {
      if (cancelBatchRef.current) break;

      const fileItem = pendingFiles[i];

      // Preventive spacing between documents (about 5 requests per minute)
      if (i > 0 && !(await waitWithCountdown(PACING_SECONDS, "pacing"))) break;

      setItem(fileItem.id, { status: "processing", progress: 30, stageLabel: "Leyendo con Gemini", errorMsg: undefined });

      let finished = false;
      let retries = 0;

      try {
        const pdfBase64 = await fileToBase64(fileItem.file);

        while (!finished && !cancelBatchRef.current) {
          setItem(fileItem.id, { progress: 65, stageLabel: "Leyendo con Gemini" });

          const response = await fetch("/api/process-form", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              pdfBase64: pdfBase64,
              fileName: fileItem.file.name,
              customApiKey: config.apiKey?.trim() || undefined,
              model: config.model,
            }),
          });

          let result: any;
          const responseText = await response.text();
          try {
            result = JSON.parse(responseText);
          } catch {
            throw new Error(`Error de red o timeout del servidor (Código: ${response.status}). Intente de nuevo.`);
          }

          const modelUsed: string = result.model || config.model;
          recordApiRequests(modelUsed, typeof result.apiCalls === "number" ? result.apiCalls : 1);

          if (cancelBatchRef.current) break;

          if (result.success) {
            const extracted = result.data;

            const newEntry: TaxEntry = {
              id: `audit-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
              fileName: fileItem.name,
              municipio: extracted.municipio || "Desconocido",
              tipo_impuesto: (extracted.tipo_impuesto || "DESCONOCIDO").toUpperCase() as any,
              nit: extracted.nit || "M-N/A",
              contribuyente: extracted.contribuyente || "Desconocido",
              periodo: extracted.periodo || "N/A",
              base_gravable: extracted.base_gravable !== undefined ? extracted.base_gravable : null,
              tarifa: extracted.tarifa !== undefined ? extracted.tarifa : null,
              valor_declarado_por_impuestos:
                extracted.valor_declarado_por_impuestos !== undefined ? extracted.valor_declarado_por_impuestos : null,
              intereses_o_sanciones:
                extracted.intereses_o_sanciones !== undefined ? extracted.intereses_o_sanciones : null,
              total_a_pagar: extracted.total_a_pagar !== undefined ? extracted.total_a_pagar : null,
              confianza_extraccion:
                extracted.confianza_extraccion !== undefined ? extracted.confianza_extraccion : undefined,
              etiqueta_detectada:
                extracted.etiqueta_detectada !== undefined ? extracted.etiqueta_detectada : undefined,
              motivo_revision: extracted.motivo_revision !== undefined ? extracted.motivo_revision : undefined,
              metodo_usado: extracted.metodo_usado !== undefined ? extracted.metodo_usado : undefined,
              mi_valor_contabilidad: 0,
              status: "success",
              processedAt: new Date().toISOString(),
            };

            setEntries((prev) => [newEntry, ...prev]);
            setItem(fileItem.id, { status: "success", progress: 100, extractedData: extracted, stageLabel: undefined });
            setApiStatus({ kind: "ok", model: modelUsed, keySource: result.keySource });
            finished = true;
            continue;
          }

          // The server reports the real error type and Google's own message
          const kind: ApiStatusKind =
            result.errorKind === "rate_minute" || result.errorKind === "overloaded" || result.errorKind === "quota_daily"
              ? result.errorKind
              : "other";
          const googleMessage: string = result.error || "La extracción por IA falló inesperadamente.";
          setApiStatus({
            kind,
            model: modelUsed,
            keySource: result.keySource,
            httpStatus: result.httpStatus,
            message: googleMessage,
          });

          if (kind === "quota_daily") {
            // Retrying cannot help: stop the batch and keep the remaining files pending
            dailyQuotaHit = true;
            break;
          }

          if ((kind === "rate_minute" || kind === "overloaded") && retries < MAX_RETRIES_PER_FILE) {
            retries++;
            const waitSeconds =
              kind === "rate_minute"
                ? Math.min((typeof result.retryAfterSeconds === "number" ? result.retryAfterSeconds : 30) + 2, 90)
                : Math.min(10 * 2 ** (retries - 1), 60);
            setItem(fileItem.id, {
              stageLabel:
                kind === "rate_minute"
                  ? `Límite por minuto · reintento ${retries}/${MAX_RETRIES_PER_FILE}`
                  : `Modelo saturado · reintento ${retries}/${MAX_RETRIES_PER_FILE}`,
            });
            if (!(await waitWithCountdown(waitSeconds, kind))) break;
            continue;
          }

          const prefix =
            kind === "rate_minute"
              ? `Límite por minuto de Google (429) tras ${MAX_RETRIES_PER_FILE} reintentos: `
              : kind === "overloaded"
              ? `Modelo saturado en Google (503, no es cuota) tras ${MAX_RETRIES_PER_FILE} reintentos: `
              : result.httpStatus
              ? `Error ${result.httpStatus} de Gemini: `
              : "";
          throw new Error(prefix + googleMessage);
        }
      } catch (err: any) {
        setItem(fileItem.id, { status: "error", progress: 100, errorMsg: err.message, stageLabel: undefined });
        finished = true;
      }

      // Not finished means cancelled or daily quota exhausted: the file stays pending
      if (!finished) break;

      completedCount++;
      setBatchProgress(Math.round((completedCount / totalToProcess) * 100));
    }

    // Anything left mid-flight goes back to pending so it can be resumed later
    setFileQueue((prev) =>
      prev.map((item) =>
        item.status === "processing" ? { ...item, status: "pending", progress: 0, stageLabel: undefined } : item
      )
    );

    if (dailyQuotaHit) {
      const remaining = totalToProcess - completedCount;
      setNoticeBanner(
        `Cuota diaria agotada para ${config.model}. El lote se detuvo y ${remaining} ${
          remaining === 1 ? "archivo queda pendiente" : "archivos quedan pendientes"
        } sin modificar. Cambia de modelo en Configuración o espera al reinicio de la cuota y pulsa "Iniciar Auditoría".`
      );
    }

    setWaitState(null);
    setIsProcessingBatch(false);
    setIsCancelling(false);
    cancelBatchRef.current = false;
  };

  // Clear file queue
  const clearQueue = () => {
    setFileQueue([]);
    setBatchProgress(0);
  };

  // Filter & Search Logic
  const filteredEntries = entries.filter((entry) => {
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      entry.municipio.toLowerCase().includes(q) ||
      entry.fileName.toLowerCase().includes(q) ||
      entry.periodo.toLowerCase().includes(q);

    const matchesType = filterType === "ALL" || entry.tipo_impuesto === filterType;

    return matchesSearch && matchesType;
  });

  return (
    <div
      onDragEnter={handleDrag}
      onDragOver={handleDrag}
      onDragLeave={handleDrag}
      onDrop={handleDrop}
      className="min-h-screen flex flex-col"
    >
      <header className="px-8 md:px-16 py-8 md:py-12 flex justify-between items-baseline">
        <div className="logo-wrap">
          <div className="meta-label mb-2">Colombian Tax Audit AI · Gemini</div>
          <h1 className="text-4xl md:text-5xl font-serif italic font-medium tracking-tight">
            Tax<span className="not-italic font-semibold text-accent">Flow</span>
          </h1>
          <p className="meta-label mt-1 opacity-80">Auditoría Inteligente</p>
        </div>
        <div className="flex gap-4 items-center">
          <button
            className="meta-label text-xs tracking-wider border-b border-ink pb-1 uppercase cursor-pointer bg-transparent hover:text-accent hover:border-accent transition-colors flex items-center gap-1 whitespace-nowrap shrink-0"
            id="btn-upload-file"
            onClick={onButtonClick}
          >
            <UploadCloud className="w-3.5 h-3.5 inline" /> Cargar Documentos
          </button>
          <button
            className="meta-label text-xs tracking-wider border-b border-ink pb-1 uppercase cursor-pointer bg-transparent hover:text-accent hover:border-accent transition-colors whitespace-nowrap shrink-0"
            id="btn-config"
            onClick={() => setShowConfig(!showConfig)}
          >
            Configuración
          </button>
          {entries.length > 0 && (
            <button
              className="meta-label text-xs tracking-wider border-b border-ink pb-1 uppercase cursor-pointer bg-transparent hover:text-accent hover:border-accent transition-colors whitespace-nowrap shrink-0"
              id="btn-export-excel"
              onClick={() => exportToExcel(entries)}
            >
              Exportar Excel
            </button>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf, .zip"
          onChange={handleFileChange}
          className="hidden"
        />
      </header>

      {noticeBanner && (
        <div className="mx-8 md:mx-16 mb-6 p-4 bg-orange-50 border border-orange-200 text-orange-800 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{noticeBanner}</span>
          </div>
          <button
            onClick={() => setNoticeBanner(null)}
            className="meta-label text-orange-800 hover:underline cursor-pointer"
          >
            Cerrar
          </button>
        </div>
      )}

      {showConfig && (
        <div className="mx-8 md:mx-16 mb-8 editorial-card p-8 border border-ink-faint animate-in fade-in slide-in-from-top-4 duration-300">
          <div className="flex items-center justify-between mb-6 border-b border-ink-faint pb-4">
            <h3 className="text-xl font-serif font-semibold text-ink flex items-center gap-2">
              <Settings className="w-5 h-5 text-accent" />
              Configuración de Extracción e IA
            </h3>
            <span className="meta-label">Gemini API</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Provider Selection */}
            <div>
              <label className="block meta-label mb-2" htmlFor="provider-select">
                Proveedor en la Nube
              </label>
              <select
                value={config.provider}
                onChange={(e) => setConfig({ ...config, provider: e.target.value as any })}
                className="w-full bg-white text-ink border border-ink-faint rounded px-4 py-3 text-sm focus:outline-none focus:border-accent shadow-sm"
                id="provider-select"
              >
                <option value="gemini">Google Gemini Cloud AI</option>
              </select>
              <p className="text-xs text-ink-muted mt-2 leading-relaxed">
                Ejecución 100% en la nube sin necesidad de servidores GPU locales.
              </p>
            </div>

            {/* Model Selection */}
            <div>
              <label className="block meta-label mb-2" htmlFor="model-select">
                Modelo Multimodal
              </label>
              <select
                value={config.model}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    model: e.target.value as Configuration["model"],
                  })
                }
                className="w-full bg-white text-ink border border-ink-faint rounded px-4 py-3 text-sm focus:outline-none focus:border-accent shadow-sm"
                id="model-select"
              >
                <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
                <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                <option value="gemini-3.5-flash">gemini-3.5-flash</option>
              </select>
              <p className="text-xs text-ink-muted mt-2 leading-relaxed">
                Cada modelo tiene su propia cuota. Si uno agota su cupo diario, cambia a otro aquí.
              </p>
            </div>

            {/* API Key */}
            <div>
              <label className="block meta-label mb-2" htmlFor="api-key-input">
                API Key (Opcional)
              </label>
              <div className="flex gap-2">
                <input
                  type={showApiKey ? "text" : "password"}
                  value={config.apiKey || ""}
                  onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
                  placeholder="Vacío = clave de AI Studio"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full min-w-0 bg-white text-ink border border-ink-faint rounded px-4 py-3 text-sm font-mono focus:outline-none focus:border-accent shadow-sm"
                  id="api-key-input"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="meta-label hover:text-accent transition-colors cursor-pointer bg-transparent shrink-0"
                >
                  {showApiKey ? "Ocultar" : "Ver"}
                </button>
                {hasCustomKey && (
                  <button
                    type="button"
                    onClick={() => setConfig({ ...config, apiKey: "" })}
                    className="meta-label text-red-700 hover:underline cursor-pointer bg-transparent shrink-0"
                    id="btn-clear-api-key"
                  >
                    Borrar
                  </button>
                )}
              </div>
              <p className="text-xs text-ink-muted mt-2 leading-relaxed">
                {hasCustomKey
                  ? "Se está usando esta clave, guardada en este navegador. La cuota que aplica es la del proyecto de esta clave."
                  : "Se está usando la clave que inyecta AI Studio (GEMINI_API_KEY)."}
              </p>
            </div>
          </div>
        </div>
      )}

      <main className="px-8 md:px-16 pb-16 max-w-[1600px] mx-auto w-full space-y-6 flex-1">
        {/* Real API status (as reported by Google) and local request counter */}
        <section
          aria-label="Estado de la API y contador de peticiones"
          className={`editorial-card px-6 py-4 border transition-colors ${
            apiStatus.kind === "quota_daily" || apiStatus.kind === "other"
              ? "border-red-300 bg-red-50/40"
              : apiStatus.kind === "rate_minute" || apiStatus.kind === "overloaded"
              ? "border-amber-300 bg-amber-50/40"
              : "border-ink-faint bg-white"
          }`}
        >
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              {apiStatus.kind === "quota_daily" ? (
                <div className="flex items-center gap-2 text-xs font-mono text-red-700">
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
                  <span className="font-bold uppercase tracking-wider">Cuota diaria agotada (429)</span>
                </div>
              ) : apiStatus.kind === "rate_minute" ? (
                <div className="flex items-center gap-2 text-xs font-mono text-amber-800">
                  <AlertCircle className="w-4 h-4 shrink-0 text-amber-600" />
                  <span className="font-bold uppercase tracking-wider">Límite por minuto (429)</span>
                </div>
              ) : apiStatus.kind === "overloaded" ? (
                <div className="flex items-center gap-2 text-xs font-mono text-amber-800">
                  <AlertCircle className="w-4 h-4 shrink-0 text-amber-600" />
                  <span className="font-bold uppercase tracking-wider">Modelo saturado en Google (503) · No es cuota</span>
                </div>
              ) : apiStatus.kind === "other" ? (
                <div className="flex items-center gap-2 text-xs font-mono text-red-700">
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
                  <span className="font-bold uppercase tracking-wider">
                    Error de la API{apiStatus.httpStatus ? ` (${apiStatus.httpStatus})` : ""}
                  </span>
                </div>
              ) : apiStatus.kind === "ok" ? (
                <div className="flex items-center gap-2 text-xs font-mono text-ink">
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-700" />
                  <span className="uppercase tracking-wider">Última petición correcta</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs font-mono text-ink-muted">
                  <span className="uppercase tracking-wider">Sin peticiones en esta sesión</span>
                </div>
              )}

              <span className="text-ink-muted text-xs" aria-hidden="true">
                ·
              </span>
              <span className="meta-label">
                Modelo: <strong className="text-ink">{config.model}</strong>
              </span>
              <span className="text-ink-muted text-xs" aria-hidden="true">
                ·
              </span>
              <span className="meta-label">
                Clave: <strong className="text-ink">{hasCustomKey ? "propia (este navegador)" : "AI Studio"}</strong>
              </span>
            </div>

            <div className="flex items-center gap-3">
              <span
                className="text-[11px] font-mono text-ink-muted uppercase tracking-wider"
                title="Conteo local de este navegador. La cuota real se consulta en el panel de uso de Google AI Studio."
              >
                Peticiones enviadas hoy:{" "}
                <strong className="text-ink tabular-nums">{requestsTodayForModel}</strong>
              </span>
              {requestsTodayForModel > 0 && (
                <button
                  onClick={resetRequestCounter}
                  title="Reiniciar contador local de peticiones"
                  className="meta-label hover:text-ink transition-colors cursor-pointer bg-transparent p-1"
                  id="btn-reset-quota-counter"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Google's own error message plus what to do about it */}
          {apiStatus.message && apiStatus.kind !== "ok" && apiStatus.kind !== "idle" && (
            <div
              className={`mt-3 pt-2.5 border-t text-xs space-y-1.5 ${
                apiStatus.kind === "quota_daily" || apiStatus.kind === "other"
                  ? "border-red-200 text-red-800"
                  : "border-amber-200 text-amber-900"
              }`}
            >
              <p>
                {apiStatus.kind === "quota_daily"
                  ? `El proyecto de la clave en uso agotó la cuota diaria de ${apiStatus.model}. Reintentar no sirve: cambia de modelo o espera al reinicio diario de Google.`
                  : apiStatus.kind === "rate_minute"
                  ? "Google pidió esperar antes de la siguiente petición. La app espera ese tiempo y reintenta el mismo archivo."
                  : apiStatus.kind === "overloaded"
                  ? "Google no pudo atender la petición por alta demanda del modelo. Tu cuota no se ve afectada; la app reintenta tras una pausa."
                  : "La petición falló por un motivo distinto a la cuota. Revisa el mensaje de Google."}
              </p>
              <p className="font-mono text-[11px] break-words whitespace-pre-wrap opacity-90">
                Mensaje de Google: {apiStatus.message}
              </p>
            </div>
          )}
        </section>

        {/* Active Queue/Batch Processing Panel */}
        {fileQueue.length > 0 && (
          <div className="editorial-card p-6 border border-ink-faint bg-[#fffcf9] space-y-4">
            <div className="flex items-center justify-between text-xs border-b border-ink-faint pb-3">
              <span className="card-title text-base font-serif font-semibold text-ink flex items-center gap-2">
                <FileText className="w-4 h-4 text-accent" />
                Cola de Procesamiento ({fileQueue.length} {fileQueue.length === 1 ? "archivo" : "archivos"})
              </span>
              <button
                onClick={clearQueue}
                disabled={isProcessingBatch}
                className="meta-label hover:text-accent disabled:opacity-50 transition-colors bg-transparent cursor-pointer"
              >
                Limpiar Cola
              </button>
            </div>

            {/* Progress Bar */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="meta-label">Progreso del lote</span>
                <span className="font-mono font-bold text-accent tabular-nums">{batchProgress}%</span>
              </div>
              <div className="h-1.5 w-full bg-ink-faint overflow-hidden">
                <div
                  className="h-full bg-accent transition-all duration-500"
                  style={{ width: `${batchProgress}%` }}
                />
              </div>
            </div>

            {waitState && (
              <div className="p-3 bg-amber-50 text-amber-900 border border-amber-200 text-[11px] flex items-center justify-center gap-2">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 text-amber-600" />
                <span>
                  {waitState.reason === "pacing"
                    ? `Pausa preventiva entre documentos: ${waitState.seconds}s`
                    : waitState.reason === "rate_minute"
                    ? `Google pidió esperar por el límite por minuto. Reintentando en ${waitState.seconds}s`
                    : `Modelo saturado en Google. Reintentando en ${waitState.seconds}s`}
                </span>
              </div>
            )}

            {/* Controls & Queue List */}
            <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 pt-2">
              <div className="flex gap-2">
                {!isProcessingBatch ? (
                  <button
                    onClick={runBatchProcessing}
                    disabled={
                      fileQueue.filter((f) => f.status === "pending" || f.status === "error").length === 0
                    }
                    className="py-2.5 px-5 text-xs font-bold uppercase tracking-widest bg-ink text-white hover:bg-accent disabled:opacity-50 transition-colors flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0"
                    id="btn-process-batch"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    Iniciar Auditoría
                  </button>
                ) : (
                  <>
                    <div className="py-2.5 px-5 text-xs font-bold uppercase tracking-widest bg-ink-faint text-ink flex items-center gap-2 whitespace-nowrap shrink-0">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Procesando...
                    </div>
                    <button
                      onClick={cancelBatchProcessing}
                      disabled={isCancelling}
                      className="py-2.5 px-4 text-xs font-bold uppercase tracking-widest bg-red-50 text-red-700 hover:bg-red-100 border border-red-200 disabled:opacity-50 transition-colors flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0"
                      id="btn-cancel-batch"
                    >
                      {isCancelling ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <>
                          <XCircle className="w-3.5 h-3.5" /> Detener
                        </>
                      )}
                    </button>
                  </>
                )}
              </div>

              {/* Queue Summary Statuses */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {fileQueue.map((item) => (
                  <span
                    key={item.id}
                    className={`px-2.5 py-1 text-[11px] border font-mono ${
                      item.status === "success"
                        ? "border-green-300 bg-green-50 text-green-800"
                        : item.status === "processing"
                        ? "border-accent/40 bg-accent/5 text-accent"
                        : item.status === "error"
                        ? "border-red-300 bg-red-50 text-red-800"
                        : "border-ink-faint bg-white text-ink-muted"
                    }`}
                    title={item.errorMsg ? `${item.name}: ${item.errorMsg}` : item.name}
                  >
                    {item.name.length > 20 ? item.name.substring(0, 18) + "..." : item.name}:{" "}
                    {item.status === "processing" && item.stageLabel
                      ? item.stageLabel.toUpperCase()
                      : item.status.toUpperCase()}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Results and Minimalist Audit Records Table */}
        <div
          className={`editorial-card p-8 border transition-colors ${
            dragActive ? "border-accent bg-accent/5" : "border-ink-faint"
          }`}
        >
          <div className="card-header border-b border-ink-faint pb-4 mb-6 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h3 className="card-title text-xl font-serif font-semibold">Registros</h3>
              {entries.length > 0 && (
                <span className="meta-label">
                  · {filteredEntries.length} {filteredEntries.length === 1 ? "declaración" : "declaraciones"}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              {entries.length > 0 && !confirmClearAll && (
                <button
                  onClick={() => setConfirmClearAll(true)}
                  className="meta-label hover:text-red-700 transition-colors bg-transparent cursor-pointer flex items-center gap-1"
                  title="Eliminar todos los registros"
                  id="btn-delete-all-tax-entries"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Limpiar
                </button>
              )}
              {confirmClearAll && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setEntries([]);
                      localStorage.removeItem("tax_audits_entries");
                      setConfirmClearAll(false);
                    }}
                    className="meta-label text-red-700 hover:underline cursor-pointer"
                  >
                    Confirmar borrado
                  </button>
                  <span className="meta-label">·</span>
                  <button
                    onClick={() => setConfirmClearAll(false)}
                    className="meta-label hover:text-ink cursor-pointer"
                  >
                    Cancelar
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Filtering & Searching tools */}
          <div className="flex flex-col md:flex-row gap-4 items-stretch md:items-center justify-between mb-6 border-b border-ink-faint pb-6">
            {/* Search Bar */}
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-ink-muted absolute left-4 top-3" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar por municipio, archivo o periodo..."
                className="w-full text-sm pl-10 pr-4 py-2.5 bg-[#fbfaf8] border border-ink-faint rounded-none text-ink placeholder-ink-muted focus:outline-none focus:border-accent transition-colors"
              />
            </div>

            {/* Type Filter Tabs */}
            <div className="flex items-center gap-1 bg-[#fbfaf8] p-1 border border-ink-faint shrink-0">
              {(["ALL", "ICA", "RETEICA"] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => setFilterType(type)}
                  className={`px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    filterType === type
                      ? "bg-ink text-white"
                      : "text-ink-muted hover:text-ink bg-transparent"
                  }`}
                >
                  {type === "ALL" ? "Todos" : type}
                </button>
              ))}
            </div>
          </div>

          {/* Results Table */}
          {filteredEntries.length === 0 ? (
            <div
              onClick={onButtonClick}
              className="flex flex-col items-center justify-center py-16 text-center text-ink-muted bg-[#fbfaf8] border border-ink-faint border-dashed cursor-pointer hover:border-accent transition-colors"
            >
              <Database className="w-10 h-10 mb-4 opacity-50" />
              <p className="font-serif text-lg mb-1">Sin registros activos</p>
              <p className="text-sm">
                Arrastra formularios PDF o paquetes ZIP aquí, o haz clic para cargar declaraciones fiscales.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden border border-ink-faint bg-white">
              {/* Table headers */}
              <div className="grid grid-cols-12 bg-[#f4f1ea] text-[10px] uppercase tracking-widest font-mono font-bold text-ink border-b border-ink-faint p-4 items-center">
                <div className="col-span-12 md:col-span-4">Municipio</div>
                <div className="col-span-12 md:col-span-2 mt-1 md:mt-0">Tipo</div>
                <div className="col-span-12 md:col-span-3 mt-1 md:mt-0">Periodo</div>
                <div className="col-span-12 md:col-span-3 text-right mt-1 md:mt-0">IA</div>
              </div>

              {/* Rows Mapping */}
              <div className="divide-y divide-ink-faint max-h-[580px] overflow-y-auto">
                {filteredEntries.map((entry) => {
                  const valueImpuestos = entry.total_a_pagar || 0;

                  return (
                    <div
                      key={entry.id}
                      className="hover:bg-[#fbfaf8] transition-colors duration-150 bg-white"
                    >
                      <div className="grid grid-cols-12 text-sm p-4 items-center">
                        {/* Municipio */}
                        <div className="col-span-12 md:col-span-4 pr-2 min-w-0">
                          <p className="font-medium text-ink truncate" title={`${entry.municipio} · ${entry.fileName}`}>
                            {entry.municipio}
                          </p>
                        </div>

                        {/* Tipo Impuesto */}
                        <div className="col-span-12 md:col-span-2 mt-1 md:mt-0">
                          <span
                            className={`meta-label ${
                              entry.tipo_impuesto === "RETEICA"
                                ? "text-stone-700"
                                : "text-orange-800"
                            }`}
                          >
                            {entry.tipo_impuesto}
                          </span>
                        </div>

                        {/* Periodo */}
                        <div className="col-span-12 md:col-span-3 mt-1 md:mt-0 text-ink-muted font-serif italic truncate">
                          {entry.periodo}
                        </div>

                        {/* Valor Impuestos + Alerta Minimalista */}
                        <div className="col-span-12 md:col-span-3 text-right mt-1 md:mt-0 flex flex-col items-end justify-center">
                          {(() => {
                            const etiquetasValidas = [
                              "TOTAL PAGO",
                              "TOTAL A PAGAR",
                              "Total a Pagar",
                              "TOTAL PAGADO",
                              "Total valor a Pagar",
                              "Total Retenciones",
                              "TOTAL SALDO A CARGO",
                            ];
                            const isEtiquetaValida = entry.etiqueta_detectada
                              ? etiquetasValidas.some((e) =>
                                  entry.etiqueta_detectada!.toLowerCase().includes(e.toLowerCase())
                                )
                              : false;
                            const requiredThreshold = isEtiquetaValida ? 0.7 : 0.85;
                            const isRevisionNecesaria =
                              entry.total_a_pagar === null ||
                              (entry.confianza_extraccion !== undefined &&
                                entry.confianza_extraccion < requiredThreshold);

                            return isRevisionNecesaria ? (
                              <div
                                className="flex flex-col items-end gap-1.5"
                                title={`Confianza: ${
                                  entry.confianza_extraccion !== undefined
                                    ? (entry.confianza_extraccion * 100).toFixed(0)
                                    : "N/A"
                                }%\nEtiqueta: ${entry.etiqueta_detectada || "N/A"}\nMotivo: ${
                                  entry.motivo_revision || "N/A"
                                }\nMétodo: ${entry.metodo_usado || "N/A"}`}
                              >
                                <span className="font-mono text-sm text-orange-600 tabular-nums">
                                  {entry.total_a_pagar === null
                                    ? "Sin valor extraído"
                                    : formatColombianPesos(valueImpuestos)}
                                </span>
                                <span className="inline-flex items-center gap-1 text-[9px] font-bold tracking-widest uppercase text-orange-600 bg-orange-50 border border-orange-200 px-1.5 py-0.5 leading-none">
                                  <AlertCircle className="w-3 h-3" /> Revisar
                                </span>
                              </div>
                            ) : (
                              <div
                                className="flex flex-col items-end gap-1"
                                title={`Confianza: ${
                                  entry.confianza_extraccion !== undefined
                                    ? (entry.confianza_extraccion * 100).toFixed(0)
                                    : "N/A"
                                }%\nEtiqueta: ${entry.etiqueta_detectada || "N/A"}\nMétodo: ${
                                  entry.metodo_usado || "N/A"
                                }`}
                              >
                                <span className="font-mono text-sm text-ink tabular-nums">
                                  {formatColombianPesos(valueImpuestos)}
                                </span>
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-ink-faint py-12 px-8 md:px-16 flex flex-col md:flex-row justify-between items-center gap-4 text-center md:text-left bg-[#fdfcf9]">
        <div className="meta-label">Gestión Tributaria Inteligente</div>
        <div className="meta-label text-ink-muted text-right">
          LECTURA NATIVA DE PDF CON GEMINI
          <br />© 2026
        </div>
      </footer>
    </div>
  );
}
