export * from '../../../../electron/features/workspaces/model.js';
export type WcsSlot = 'G54' | 'G55' | 'G56' | 'G57' | 'G58' | 'G59';
export interface SavedPosition { x: number; y: number; z: number; savedAt: string }
export interface WorkspaceChange {
  id: string; at: string; label: string;
  before: Partial<Record<WcsSlot, SavedPosition | null>>;
  after: Partial<Record<WcsSlot, SavedPosition | null>>;
}
export interface Workspace {
  id: string; name: string; note?: string;
  slots: Partial<Record<WcsSlot, SavedPosition>>;
  createdAt: string; history?: WorkspaceChange[]; historyIndex?: number;
}
