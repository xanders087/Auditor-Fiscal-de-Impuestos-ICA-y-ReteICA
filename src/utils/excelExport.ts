import * as XLSX from "xlsx";
import { TaxEntry } from "../types";

/**
 * Exports the audited tax entries directly to a formatted Excel file (.xlsx)
 * @param entries List of processed tax entries
 */
export function exportToExcel(entries: TaxEntry[]) {
  if (entries.length === 0) {
    return;
  }

  // Map the internal data structure to highly professional Spanish financial terms
  const worksheetData = entries.map((entry) => {
    const nit = (entry.fileName || "").split("_")[0].replace(/\D/g, "").substring(0, 9);
    return {
      "Archivo": entry.fileName || "",
      "NIT": nit,
      "Valor a Pagar": entry.total_a_pagar || 0,
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(worksheetData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Impuestos Auditados");

  // Format header row to look neat, and calculate column widths
  const maxCols = Object.keys(worksheetData[0] || {});
  const colWidths = maxCols.map((key) => {
    let maxLen = key.length;
    worksheetData.forEach((row: any) => {
      const cellVal = String(row[key] || "");
      if (cellVal.length > maxLen) {
        maxLen = cellVal.length;
      }
    });
    return { wch: Math.min(Math.max(maxLen + 3, 10), 50) }; // cap between 10 and 50 characters
  });

  worksheet["!cols"] = colWidths;

  // Generate filename with timestamp
  const dateStr = new Date().toISOString().split("T")[0];
  const filename = `Reporte_Auditoria_ICA_Colombia_${dateStr}.xlsx`;

  XLSX.writeFile(workbook, filename);
}
