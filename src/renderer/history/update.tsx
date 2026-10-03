import { ArrowDownToLine, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { UpdateState } from "../../core/types";
import { useStrings } from "../lang";

export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    void ciao.update.get().then(setState);
    return ciao.update.onState(setState);
  }, []);
  return state;
}

/** The pill in the title bar: shown only while there is an update to install or one is underway. */
export function UpdateButton({ state }: { state: UpdateState | null }) {
  const tr = useStrings().update;
  if (!state) return null;
  if (state.phase === "available" || (state.phase === "error" && state.version))
    return (
      <button
        onClick={() => void ciao.update.install()}
        title={state.phase === "error" ? state.message : tr.buttonTitle(state.current)}
        className="no-drag inline-flex items-center gap-1.5 rounded-lg bg-accent/15 px-2.5 py-1 text-[12.5px] text-accent transition-colors hover:bg-accent/25"
      >
        <ArrowDownToLine className="size-3.5" />
        {state.phase === "error" ? tr.retryUpdate : tr.updateTo(state.version)}
      </button>
    );
  if (state.phase === "downloading" || state.phase === "installing")
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[12.5px] text-muted">
        <Loader2 className="size-3.5 animate-spin" />
        {state.phase === "downloading" ? tr.downloading(state.version, state.percent) : tr.restarting}
      </span>
    );
  return null;
}
