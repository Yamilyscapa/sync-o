import { Agent } from "@openai/agents";
import type { AgentContext } from "../agent.js";
import { buildAnalysisPrompt } from "../prompts/analysis.js";
import { DEFAULT_LOCALE, type Locale } from "../prompts/system.js";
import { productsTools } from "../tools/products/index.js";
import {
  getSupplierTool,
  listProductSuppliersTool,
  listSupplierProductsTool,
  listSuppliersTool,
  resolveSupplierTool,
} from "../tools/suppliers/list.js";
import { getStockHistory, listStockMovements } from "../tools/movements/list.js";

const analysisReadTools = [
  ...productsTools,
  listSuppliersTool,
  getSupplierTool,
  resolveSupplierTool,
  listProductSuppliersTool,
  listSupplierProductsTool,
  listStockMovements,
  getStockHistory,
];

export const buildAnalysisAgent = (locale: Locale = DEFAULT_LOCALE) =>
  new Agent<AgentContext>({
    name: "sync-o-analysis",
    instructions: buildAnalysisPrompt(locale),
    model: "gpt-5-mini",
    modelSettings: {
      promptCacheRetention: "24h",
    },
    tools: analysisReadTools,
  });

// Post-processing sanitizer applied to sub-agent output before main agent
// receives it. The model occasionally ignores explicit prompt bans (e.g.
// keeps writing "lead time", "Resumen ejecutivo", or trailing "Si quieres
// puedo…" offers), so this is defense-in-depth, not a replacement for the
// prompt rules. Only runs on es-MX output.
const EN_TO_ES: Array<[RegExp, string]> = [
  [/\blead times?\b/gi, "tiempo de entrega"],
  [/\btop movers?\b/gi, "los más vendidos"],
  [/\bbest sellers?\b/gi, "los más vendidos"],
  [/\bintakes\b/gi, "entradas"],
  [/\bintake\b/gi, "entrada"],
  [/\bdead stock\b/gi, "sin movimiento"],
  [/\bslow stock\b/gi, "sin movimiento"],
  [/\bslow[- ]moving\b/gi, "rotación nula"],
  [/\breorder points?\b/gi, "punto de reorden"],
  [/\bsafety stock\b/gi, "stock de seguridad"],
];

const CORPORATE_HEADERS_RE =
  /^\s*(Resumen ejecutivo( corto)?|Resumen principal|Resumen corto|Observaciones( generales)?|Limitaciones importantes|Limitaciones y datos faltantes|Datos clave verificados)\s*:?\s*$/gim;

const TRAILING_OFFER_RE =
  /(\n[ \t]*\n[ \t]*|\n[ \t]*[-•] *)?(Si quieres\b|Si prefieres\b|¿Quieres que\b|¿Algo m[aá]s\b|¿Qu[eé] prefieres\b|Ind[ií]came\b|Indica qu[eé]\b|Dime (el|qu[eé]|cu[aá]l)\b)[\s\S]*$/i;

export function sanitizeAnalysisOutput(text: string, locale: Locale): string {
  if (locale !== "es-MX") return text;
  let out = text;
  for (const [re, rep] of EN_TO_ES) out = out.replace(re, rep);
  out = out.replace(CORPORATE_HEADERS_RE, "");
  out = out.replace(TRAILING_OFFER_RE, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
