package assistanttask

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestRecordResponsesCarryOutcomeFieldsOnlyForOutcomeRecords(t *testing.T) {
	at := time.Date(2026, 11, 19, 8, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name   string
		record model.AssistantTaskRecord
		want   map[string]any
	}{
		{"outcome", model.AssistantTaskRecord{ID: testID, TaskID: testTask, Author: "bot", AuthorBotID: pointer(testBot), Kind: "outcome", Text: "cleared", Outcome: pointer("ineffective"), ActionRecordID: pointer(testOperation), Refs: json.RawMessage(`{"eventIds":["evt-1"]}`), CreatedAt: at}, map[string]any{"outcome": "ineffective", "actionRecordId": testOperation}},
		{"action", model.AssistantTaskRecord{ID: testID, TaskID: testTask, Author: "bot", AuthorBotID: pointer(testBot), Kind: "action", Text: "restarted", Refs: json.RawMessage(`[]`), CreatedAt: at}, map[string]any{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			h := testHandler(t, func(context.Context, core.Actor, string, ...any) (any, error) {
				return model.AssistantTaskPage[model.AssistantTaskRecord]{Items: []model.AssistantTaskRecord{test.record}, ObservedAt: at}, nil
			}, io.Discard)
			response := request(h, http.MethodGet, taskPath+"/records", "", true)
			var page struct{ Items []map[string]any }
			if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &page) != nil || len(page.Items) != 1 {
				t.Fatalf("status=%d body=%s", response.Code, response.Body)
			}
			for _, key := range []string{"outcome", "actionRecordId"} {
				value, present := page.Items[0][key]
				if want, expected := test.want[key]; present != expected || value != want {
					t.Fatalf("%s=%v present=%v body=%s", key, value, present, response.Body)
				}
			}
		})
	}
}

func TestOutcomeRecordRefusalFromCoreIsInvalidInput(t *testing.T) {
	h := testHandler(t, func(_ context.Context, _ core.Actor, name string, args ...any) (any, error) {
		input := args[0].(core.RecordInput)
		if name != "AddRecord" || input.Kind != "note" || input.Outcome == nil || *input.Outcome != "effective" {
			t.Fatalf("outcome field not forwarded: %s %+v", name, input)
		}
		return nil, &model.Fault{Code: "invalid_input", Message: "Only outcome records carry an outcome value or action record ID."}
	}, io.Discard)
	response := request(h, http.MethodPost, taskPath+"/records", `{"id":"`+testID+`",`+claimBody+`,"kind":"note","text":"note","outcome":"effective"}`, true)
	assertError(t, response, http.StatusBadRequest, "invalid_input")
	var body api.ErrorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Error.Message != "Only outcome records carry an outcome value or action record ID." {
		t.Fatalf("refusal lost its explanation: %s %v", response.Body, err)
	}
}
