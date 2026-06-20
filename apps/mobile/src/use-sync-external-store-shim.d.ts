/* Local typing for the React-maintained selector shim. The package ships JS
   without bundled types for this subpath; this mirrors @types/use-sync-external-store
   so we keep full generic inference (useSyncStore<T> stays T) without adding a
   dependency / churning the lockfile. */
declare module 'use-sync-external-store/shim/with-selector' {
  export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => Snapshot,
    getServerSnapshot: undefined | null | (() => Snapshot),
    selector: (snapshot: Snapshot) => Selection,
    isEqual?: (a: Selection, b: Selection) => boolean,
  ): Selection;
}
