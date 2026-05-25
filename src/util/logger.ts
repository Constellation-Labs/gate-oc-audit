import {createSubsystemLogger, type SubsystemLogger} from "openclaw/plugin-sdk/runtime";

export const log: SubsystemLogger = createSubsystemLogger("audit-plugin");
export const smtLog: SubsystemLogger = createSubsystemLogger("audit-plugin:smt");
export const deAnchorLog: SubsystemLogger = createSubsystemLogger("audit-plugin:de-anchor");
export const rateLimiterLog: SubsystemLogger = createSubsystemLogger("audit-plugin:rate-limiter");
export const smtTreeManagerLog: SubsystemLogger = createSubsystemLogger("audit-plugin:smt-tree-manager");
