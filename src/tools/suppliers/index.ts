import {
  getSupplierTool,
  listProductSuppliersTool,
  listSupplierProductsTool,
  listSuppliersTool,
  resolveSupplierTool,
} from "./list.js";
import {
  createSupplierTool,
  deactivateSupplierTool,
  linkProductSupplierTool,
  setPreferredSupplierTool,
  unlinkProductSupplierTool,
  updateSupplierTool,
} from "./write.js";

export const suppliersTools = [
  listSuppliersTool,
  getSupplierTool,
  resolveSupplierTool,
  listProductSuppliersTool,
  listSupplierProductsTool,
  createSupplierTool,
  updateSupplierTool,
  deactivateSupplierTool,
  linkProductSupplierTool,
  unlinkProductSupplierTool,
  setPreferredSupplierTool,
];
