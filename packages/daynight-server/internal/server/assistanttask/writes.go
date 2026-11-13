package assistanttask

import (
	"net/http"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
)

func decode(w http.ResponseWriter, r *http.Request, allowed ...string) inputFields {
	if err := noQuery(r); err != nil {
		return inputFields{err: err}
	}
	fields, err := httpx.DecodeObject(w, r, allowed...)
	return inputFields{fields: fields, err: err}
}
func (p *inputFields) optionalText(key string) *string {
	if p.fields[key] == nil {
		return nil
	}
	value := p.text(key, false)
	return &value
}
func (p *inputFields) optionalID(key string) *string {
	if p.fields[key] == nil {
		return nil
	}
	value := p.id(key, false)
	return &value
}
func (p *inputFields) ids(key string) []string {
	values := p.strings(key)
	for _, value := range values {
		if p.err == nil {
			_, p.err = strictID(value)
		}
	}
	return values
}
func (p *inputFields) mutation(taskID, id string, claim bool) core.Mutation {
	if id == "" {
		id = p.id("id", true)
	}
	input := core.Mutation{TaskID: taskID, ID: id}
	if claim || p.fields["claimToken"] != nil || p.fields["claimGeneration"] != nil {
		input.ClaimToken = p.token(true)
		input.ClaimGeneration = p.integer("claimGeneration", true, false)
	}
	return input
}

func (h *handler) create(w http.ResponseWriter, r *http.Request, a core.Actor, _, _ string) (any, error) {
	p := decode(w, r, "id", "name", "purpose", "scope", "kind", "takeover", "application", "trigger", "manual")
	input := core.CreateInput{ID: p.id("id", true), Name: p.text("name", true), Purpose: p.text("purpose", true), Scope: p.text("scope", true), Kind: p.text("kind", true), Takeover: p.text("takeover", true), Application: p.text("application", false), Trigger: p.fields["trigger"]}
	if p.err == nil {
		fields, err := jsonobject.Decode(p.fields["manual"], "manual", "body", "rules")
		if err != nil {
			p.err = httpx.InvalidInput(err.Error())
		} else {
			manual := inputFields{fields: fields}
			input.Body = manual.text("body", true)
			input.Rules = manual.raw("rules")
			p.err = manual.err
		}
	}
	if p.err != nil {
		return nil, p.err
	}
	value, err := h.tasks.Create(r.Context(), a, input)
	return taskResponse(value), err
}
func (h *handler) update(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	p := decode(w, r, "ifVersion", "name", "purpose", "scope", "takeover", "trigger", "state")
	input := core.UpdateInput{TaskID: taskID, IfVersion: p.integer("ifVersion", true, false), Name: p.optionalText("name"), Purpose: p.optionalText("purpose"), Scope: p.optionalText("scope"), Takeover: p.optionalText("takeover"), State: p.optionalText("state")}
	if p.fields["trigger"] != nil {
		value := p.fields["trigger"]
		input.Trigger = &value
	}
	if p.err != nil {
		return nil, p.err
	}
	value, err := h.tasks.Update(r.Context(), a, input)
	return taskResponse(value), err
}
func (h *handler) remove(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	p := decode(w, r, "ifVersion")
	state := "deleted"
	input := core.UpdateInput{TaskID: taskID, IfVersion: p.integer("ifVersion", true, false), State: &state}
	if p.err != nil {
		return nil, p.err
	}
	value, err := h.tasks.Update(r.Context(), a, input)
	return taskResponse(value), err
}
func (h *handler) addAppendix(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	p := decode(w, r, "id", "claimToken", "claimGeneration", "text", "sourceRecords")
	input := core.AppendixInput{Mutation: p.mutation(taskID, "", true), Text: p.text("text", true), SourceRecords: p.ids("sourceRecords")}
	if p.err != nil {
		return nil, p.err
	}
	value, err := h.tasks.AddAppendix(r.Context(), a, input)
	return appendixResponse(value), err
}
func (h *handler) updateAppendix(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, id string) (any, error) {
	p := decode(w, r, "ifVersion", "text", "sourceRecords")
	input := core.AppendixInput{Mutation: core.Mutation{TaskID: taskID, ID: id, IfVersion: p.integer("ifVersion", true, false)}, Text: p.text("text", true), SourceRecords: p.ids("sourceRecords"), State: "edited"}
	if p.err != nil {
		return nil, p.err
	}
	value, err := h.tasks.UpdateAppendix(r.Context(), a, input)
	return appendixResponse(value), err
}
func (h *handler) deleteAppendix(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, id string) (any, error) {
	p := decode(w, r, "ifVersion")
	input := core.AppendixInput{Mutation: core.Mutation{TaskID: taskID, ID: id, IfVersion: p.integer("ifVersion", true, false)}, State: "deleted"}
	if p.err != nil {
		return nil, p.err
	}
	value, err := h.tasks.UpdateAppendix(r.Context(), a, input)
	return appendixResponse(value), err
}
func (h *handler) propose(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	p := decode(w, r, "id", "claimToken", "claimGeneration", "baseVersion", "body", "rules", "reason", "evidenceRecords")
	input := core.ProposalInput{Mutation: p.mutation(taskID, "", true), BaseVersion: p.integer("baseVersion", true, false), Body: p.text("body", true), Rules: p.raw("rules"), Reason: p.text("reason", true), EvidenceRecords: p.ids("evidenceRecords")}
	if p.err != nil {
		return nil, p.err
	}
	value, err := h.tasks.Propose(r.Context(), a, input)
	return proposalResultResponse(value), err
}
func (h *handler) decide(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, id string) (any, error) {
	p := decode(w, r, "ifVersion", "decision", "note", "body", "rules")
	input := core.DecisionInput{TaskID: taskID, ID: id, IfVersion: p.integer("ifVersion", true, false), Decision: p.text("decision", true), Note: p.text("note", false), Body: p.optionalText("body")}
	if p.fields["rules"] != nil {
		value := p.raw("rules")
		input.Rules = &value
	}
	if p.err != nil {
		return nil, p.err
	}
	value, err := h.tasks.Decide(r.Context(), a, input)
	return proposalResponse(value), err
}
func (h *handler) rollback(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	p := decode(w, r, "ifVersion", "manualVersion")
	input := core.RollbackInput{TaskID: taskID, IfVersion: p.integer("ifVersion", true, false), ManualVersion: p.integer("manualVersion", true, false)}
	if p.err != nil {
		return nil, p.err
	}
	value, err := h.tasks.Rollback(r.Context(), a, input)
	return manualResponse(value), err
}

func (h *handler) addItem(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	return h.saveItem(w, r, a, taskID, "")
}
func (h *handler) updateItem(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, id string) (any, error) {
	return h.saveItem(w, r, a, taskID, id)
}
func (h *handler) saveItem(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, id string) (any, error) {
	allowed := []string{"claimToken", "claimGeneration", "key", "episode", "state", "category", "appState"}
	if id == "" {
		allowed = append(allowed, "id")
	} else {
		allowed = append(allowed, "ifVersion")
	}
	p := decode(w, r, allowed...)
	input := core.ItemInput{Mutation: p.mutation(taskID, id, true), Key: p.text("key", true), Episode: p.integer("episode", true, false), State: p.text("state", true), Category: p.text("category", true), AppState: p.raw("appState")}
	if id != "" {
		version := p.integer("ifVersion", true, false)
		input.ItemVersion = &version
	}
	if p.err != nil {
		return nil, p.err
	}
	value, err := h.tasks.SaveItem(r.Context(), a, input)
	return itemResponse(value), err
}
func (h *handler) addRecord(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	p := decode(w, r, "id", "claimToken", "claimGeneration", "itemId", "kind", "text", "refs")
	input := core.RecordInput{Mutation: p.mutation(taskID, "", false), ItemID: p.optionalID("itemId"), Kind: p.text("kind", true), Text: p.text("text", true), Refs: p.raw("refs")}
	if p.err != nil {
		return nil, p.err
	}
	value, err := h.tasks.AddRecord(r.Context(), a, input)
	return recordResponse(value), err
}
func (h *handler) addEvent(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	p := decode(w, r, "id", "claimToken", "claimGeneration", "targetBotId", "type", "payload")
	input := core.EventInput{Mutation: p.mutation(taskID, "", true), TargetBotID: p.id("targetBotId", true), Type: p.text("type", true), Payload: p.raw("payload")}
	if p.err != nil {
		return nil, p.err
	}
	value, err := h.tasks.AddEvent(r.Context(), a, input)
	return eventResponse(value), err
}
func (h *handler) ackEvent(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, id string) (any, error) {
	p := decode(w, r, "operationId", "state")
	input := core.AckEventInput{TaskID: taskID, ID: id, OperationID: p.id("operationId", true), State: p.text("state", false)}
	if p.err == nil && p.fields["state"] != nil && input.State != "delivered" && input.State != "expired" {
		p.err = httpx.InvalidInput("state must be delivered or expired")
	}
	if p.err != nil {
		return nil, p.err
	}
	value, err := h.tasks.AckEvent(r.Context(), a, input)
	return eventResponse(value), err
}
func (h *handler) clearAttention(w http.ResponseWriter, r *http.Request, a core.Actor, _, _ string) (any, error) {
	p := decode(w, r, "targetBotId")
	target := p.id("targetBotId", true)
	if p.err != nil {
		return nil, p.err
	}
	err := h.tasks.ClearAttention(r.Context(), a, target)
	return struct {
		TargetBotID string `json:"targetBotId"`
	}{target}, err
}
func (h *handler) botAttentionSeen(w http.ResponseWriter, r *http.Request, a core.Actor, _, id string) (any, error) {
	p := decode(w, r)
	if p.err != nil {
		return nil, p.err
	}
	err := h.tasks.ClearAttention(r.Context(), a, id)
	return struct {
		TargetBotID string `json:"targetBotId"`
	}{id}, err
}

func (h *handler) ask(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	p := decode(w, r, "id", "itemId", "question")
	input := core.InquiryInput{Mutation: p.mutation(taskID, "", false), ItemID: p.optionalID("itemId"), Question: p.text("question", true)}
	if p.err != nil {
		return nil, p.err
	}
	value, err := h.tasks.Ask(r.Context(), a, input)
	return inquiryResponse(value), err
}
func (h *handler) answer(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, id string) (any, error) {
	p := decode(w, r, "claimToken", "claimGeneration", "answer")
	input := core.AnswerInput{Mutation: p.mutation(taskID, id, true), Answer: p.text("answer", true)}
	if p.err != nil {
		return nil, p.err
	}
	value, err := h.tasks.Answer(r.Context(), a, input)
	return inquiryResponse(value), err
}
