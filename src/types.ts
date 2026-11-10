export type TaxType = "ICA" | "RETEICA" | "DESCONOCIDO";

export interface TaxEntry {
  id: string;
  fileName: string;
  municipio: string;
  tipo_impuesto: TaxType;
  nit: string;
  contribuyente: string;
  periodo: string;
  base_gravable: number | null;
  tarifa: number | null;
  valor_declarado_por_impuestos: number | null;
  intereses_o_sanciones: number | null;
  total_a_pagar: number | null;
  confianza_extraccion?: number;
  etiqueta_detectada?: string;
  motivo_revision?: string;
  metodo_usado?: string;
  mi_valor_contabilidad: number;
  status: "pending" | "processing" | "success" | "error";
  errorMsg?: string;
  processedAt?: string;
}

export interface Configuration {
  provider: "gemini";
  model: "gemini-3.1-flash-lite" | "gemini-2.5-flash" | "gemini-3.5-flash";
  apiKey?: string;
}

export interface FileItem {
  id: string;
  file: File;
  name: string;
  size: number;
  status: "pending" | "processing" | "success" | "error";
  progress: number;
  stageLabel?: string;
  extractedData?: Partial<TaxEntry>;
  errorMsg?: string;
}
