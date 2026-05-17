import { readStockBySku } from "./stock.js";
import { resolveProduct } from "./resolve.js";

export const productsTools = [resolveProduct, readStockBySku];
