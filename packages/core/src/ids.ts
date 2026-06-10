import { randomUUID } from "node:crypto";
export const id = (): string => randomUUID();
export const now = (): number => Date.now();
