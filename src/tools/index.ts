import { movementsTools } from "./movements/index.js";
import { productsTools } from "./products/index.js";
import { suppliersTools } from "./suppliers/index.js";

export const tools = [...productsTools, ...suppliersTools, ...movementsTools];
