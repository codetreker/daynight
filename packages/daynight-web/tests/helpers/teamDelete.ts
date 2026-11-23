import { fireEvent, waitFor } from "@testing-library/react";

export const expandTeamDelete = async () => {
  const summary = await waitFor(() => {
    const node = Array.from(document.querySelectorAll<HTMLElement>("details.team-delete summary")).find((item) => !item.closest("[hidden]"));
    if (!node) throw new Error("Team delete disclosure is not visible");
    return node;
  });
  if (!summary.closest("details")!.open) fireEvent.click(summary);
};
