import { useEffect, useState } from "react";
import { me } from "../../api/auth";
import { ApiError, isAbortError } from "../../api/client";

export const useNavigationIdentity = () => {
  const [identity, setIdentity] = useState<"unknown" | "anonymous" | "authenticated" | "error">("unknown");
  useEffect(() => {
    const controller = new AbortController();
    void me(controller.signal).then(() => {
      if (!controller.signal.aborted) setIdentity("authenticated");
    }).catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return;
      setIdentity(error instanceof ApiError && error.status === 401 ? "anonymous" : "error");
    });
    return () => controller.abort();
  }, []);
  return identity;
};
