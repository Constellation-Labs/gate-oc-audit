import {createSubsystemLogger, type SubsystemLogger} from "openclaw/plugin-sdk/runtime";

export const log: SubsystemLogger = createSubsystemLogger("gate-oc-audit");
export const smtLog: SubsystemLogger = createSubsystemLogger("gate-oc-audit:smt");
export const deAnchorLog: SubsystemLogger = createSubsystemLogger("gate-oc-audit:de-anchor");
export const rateLimiterLog: SubsystemLogger = createSubsystemLogger("gate-oc-audit:rate-limiter");
export const smtTreeManagerLog: SubsystemLogger = createSubsystemLogger("gate-oc-audit:smt-tree-manager");
