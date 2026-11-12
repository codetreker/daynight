import { useAccountSession } from "../../app/AccountSessionProvider";

export const useNavigationIdentity = () => {
  const { session } = useAccountSession();
  return session.status === "loading" ? "unknown" : session.status;
};
