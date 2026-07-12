export type RuntimeDrainWork={turnAdmissionInFlight:number;activeTurnCount:number;submittingTurnCount:number;claudeActiveTurnCount:number;geminiActivePromptCount:number;appendQueueCount:number;deltaQueueEventCount:number;pendingSqliteWriteCount:number;pendingPushCount:number;subscriberPendingBufferCount:number};

export function runtimeIsDrained(work:RuntimeDrainWork){return Object.values(work).every(value=>Number(value)===0);}
