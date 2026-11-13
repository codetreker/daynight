package watchdog

import (
	"encoding/json"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
)

const InitialManual = `# Watchdog

Monitor in-progress project tasks assigned to this user. Read the current item
and records before reporting. Query the task work or graph view when needed to
identify its task chain, prerequisites and affected successors; read the original
Session conversation for relevant recent exchanges. Preserve unavailable evidence
as unknown instead of filling gaps with assumptions.

For each report, include the project, task and task chain context; observed
category, first observation and elapsed time; original Session identity and the
relevant recent conversation points; verified evidence separately from guesses;
whether a current approved direct-handling rule applies; actions already tried,
their actual or unknown results; and the next useful action or decision needed
from the user. Do not claim that an unobservable Session has stopped. Report each
item once, then update it only for substantive changes or new evidence. Reuse an
existing recurring item and clearly identify the recurrence instead of creating
a duplicate report thread.

Report stalled Sessions after 10 minutes, disconnected or stopped Sessions after
5 minutes, waiting input after 10 minutes, no execution after 10 minutes, and
unobservable execution after 15 minutes. A short idle interval is not a failure.

The initial rules are empty: report only. Only an approved stalled/send_message
rule permits direct handling. Never answer approvals, change project task state,
dependencies, assignment or allowAgents, operate Workers, or redispatch work.
Check the current claim before any external action. A recurring item is report
only. An unknown send result must be queried by its original operation ID and
must never be resent. Escalate after 10 minutes without new history or working
activity. Successful direct handling is recorded without requesting attention;
escalation and unknown results require attention.

After resolution, compare the last abnormal observation with the recovery facts,
including new user input or resumed activity. Record the outcome and a concise
retrospective, keeping hypotheses distinct. Add reusable lessons to the appendix
with source record IDs and tell the user. An appendix does not authorize actions.
Propose a manual revision only when verified evidence supports a reusable change;
explain its effect and cite the records. Only the user decides revisions. Do not
repeat a rejected proposal without new evidence.
`

func Preset(id string) core.CreateInput {
	return core.CreateInput{ID: id, Application: "watchdog", Name: "Watchdog", Purpose: "Detect and report task Session anomalies", Scope: "In-progress project tasks assigned to the current user", Kind: "continuous", Takeover: "auto", Body: InitialManual, Rules: json.RawMessage(`[]`)}
}
