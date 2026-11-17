import { useEffect, useRef, useState } from "react";
import { addExistingTeamMember, type AddExistingTeamMemberReceipt } from "../../../api/team-member-search";
import { ApiError, authRequestsPaused } from "../../../api/client";
import type { TaskCacheScope } from "../../task-cache/TaskCacheProvider";
import { useOperation } from "../TeamManagement";

type Options = {
  readonly teamId: string;
  readonly admission: TaskCacheScope;
  readonly onIdentityMismatch: () => void;
  readonly admin: boolean;
  readonly canStart: () => boolean;
  readonly getPermissionRevision: () => number | null;
  readonly onStart: () => void;
  readonly onResponse: () => void;
  readonly onGuardChange: (retain: boolean, lock: boolean) => void;
  readonly onReceipt: (receipt: AddExistingTeamMemberReceipt) => boolean;
  readonly onPermissionChange: () => void;
  readonly onCheck: () => Promise<boolean | undefined>;
};

// The owner is independent of the search popup and survives permission changes.
export const useTeamMemberAddition = (options: Options) => {
  const latest = useRef(options); latest.current = options;
  const [targetId, setTargetId] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ readonly targetId: string; readonly added: boolean } | null>(null);
  const [observed, setObserved] = useState(false), [checking, setChecking] = useState(false);
  const started = useRef(false);
  const operation = useOperation(options.admission);
  const op = useRef(operation); op.current = operation;
  const unknown = operation.result?.kind === "unknown";
  const retain = operation.pending || operation.publicationPending || operation.publishing() || unknown || operation.publicationError !== null;
  const lock = options.admin && (retain || started.current);
  useEffect(() => {
    started.current = false;
    latest.current.onGuardChange(retain, options.admin && retain);
  }, [retain, options.admin]);
  useEffect(() => { if (!options.admin) setSuccess(null); }, [options.admin]);
  useEffect(() => () => latest.current.onGuardChange(false, false), []);
  const add = (userId: string) => {
    if (started.current || !latest.current.admin || !latest.current.canStart() || authRequestsPaused() || op.current.pending || op.current.publicationPending || op.current.publishing() || op.current.publicationError !== null || op.current.result?.kind === "unknown") return;
    const revision = latest.current.getPermissionRevision();
    if (revision === null) return;
    started.current = true; setTargetId(userId); setSuccess(null); setObserved(false); latest.current.onStart();
    latest.current.onGuardChange(true, true);
    const owner = latest.current;
    void op.current.run(async (signal, dispatched) => {
      if (!latest.current.admin || !latest.current.canStart() || latest.current.getPermissionRevision() !== revision || authRequestsPaused()) throw new ApiError("protocol");
      const receipt = await addExistingTeamMember(owner.admission.userId, owner.teamId, userId, signal, owner.onIdentityMismatch, dispatched);
      latest.current.onResponse();
      return receipt;
    }, receipt => { if (latest.current.onReceipt(receipt) && latest.current.admin) setSuccess({ targetId: userId, added: receipt.added }); }, failure => {
      if (failure instanceof ApiError && failure.kind === "server" && (failure.status === 403 || failure.status === 404 && failure.code !== "user_not_found")) latest.current.onPermissionChange();
    });
  };
  const check = () => {
    if (checking || op.current.result?.kind !== "unknown") return;
    setChecking(true);
    void latest.current.onCheck().then(ok => { if (ok && op.current.result?.kind === "unknown") setObserved(true); }).finally(() => setChecking(false));
  };
  return { targetId, pending: operation.pending || operation.publicationPending, unknown, checking, error: operation.result?.error ?? null, observed, locked: lock, retain, success, add, check, operation };
};
