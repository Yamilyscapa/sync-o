import { readStockBySku } from "./stock.js";
import { resolveProduct } from "./resolve.js";
import { listLowStockTool, listProductsTool, listStockTool } from "./list.js";

export const productsTools = [
  resolveProduct,
  readStockBySku,
  listProductsTool,
  listStockTool,
  listLowStockTool,
];
