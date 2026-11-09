package session

import (
	"context"
	"strings"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func nativeOfferCommand(t *testing.T, fence sp.Fence, text string) sp.Command {
	t.Helper()
	payload, err := sp.MarshalWire(sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: text}}})
	if err != nil {
		t.Fatal(err)
	}
	c := sp.Command{Fence: fence, Protocol: sp.Protocol, RequestID: "offer-budget", OperationID: uuid.NewString(), Kind: "send_message", Payload: payload}
	raw, err := sp.MarshalWire(c)
	if err != nil {
		t.Fatal(err)
	}
	c, err = sp.DecodeCommand(raw)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestOfferBudgetUsesNativeWireBytesAndPreservesQueueProgress(t *testing.T) {
	f, v := connectFixture(t)
	publishState(t, f, v, idleState())
	ctx := context.Background()
	commands := []sp.Command{nativeOfferCommand(t, v.Fence, strings.Repeat("<", 400000)), nativeOfferCommand(t, v.Fence, "following command")}
	responses := configureContentOperations(t, f, commands...)
	f.dao.Expect("SessionOperation", 6)
	f.dao.Expect("InsertSessionOperation", 2)
	f.dao.Expect("PendingSessionOperationCount", 2)
	f.dao.Expect("AcceptedSessionOperations", 1)
	f.dao.Expect("SetSessionOperationEpoch", 2)
	f.dao.Expect("SetSessionOperationReceipt", 2)
	for i, command := range commands {
		responses.pending = i
		if _, err := f.s.Submit(f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1}), f.p, f.project, f.task, v.SessionID, command); err != nil {
			t.Fatal(err)
		}
		f.SelectSessionWrite(t)
		responses.useProposedResponse(command.OperationID, f.s.now().Add(time.Minute))
		responses.accepted = append(responses.accepted, command.OperationID)
	}
	offers, err := f.s.Poll(f.ControllerPhase(ctx, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 2, "LockCredential": 3, "ProjectAccess": 3, "SetSessionOperationEpoch": 2, "SetSessionOperationReceipt": 2, "SaveSession": 1}), v.ControllerFence)
	if err != nil || len(offers) != 2 {
		t.Fatalf("legal HTML command blocked its queue: offers=%d err=%v", len(offers), err)
	}
	f.SelectSessionWrite(t)
	for i, offer := range offers {
		wire, err := sp.MarshalWire(offer)
		if err != nil || len(wire) > sp.MaxFrameBytes {
			t.Fatalf("offer frame exceeds wire budget: %d %v", len(wire), err)
		}
		command := offer["command"].(sp.Command)
		responses.useProposedResponse(command.OperationID, f.s.now().Add(time.Minute))
		if command.OperationID != commands[i].OperationID || string(command.Payload) != string(commands[i].Payload) {
			t.Fatal("offer changed original command")
		}
		receipt, err := f.s.Operation(f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1}), f.p, f.project, f.task, v.SessionID, command.OperationID)
		if err != nil || receipt.State != "offered" {
			t.Fatal("bounded command not offered", receipt.State, err)
		}
	}
}

func TestOfferBudgetRejectsOversizedEnvelopeWithoutStarvingFollowingCommand(t *testing.T) {
	f, v := connectFixture(t)
	publishState(t, f, v, idleState())
	ctx := context.Background()
	oversized := nativeOfferCommand(t, v.Fence, "placeholder")
	payload := sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: ""}, {Type: "text", Text: ""}}}
	oversized.Payload, _ = sp.MarshalWire(payload)
	empty, _ := sp.MarshalWire(oversized)
	characters := sp.MaxFrameBytes - 1 - len(empty)
	payload.Content[0].Text = strings.Repeat("x", characters/2)
	payload.Content[1].Text = strings.Repeat("y", characters-characters/2)
	oversized.Payload, _ = sp.MarshalWire(payload)
	inbound, err := sp.MarshalWire(oversized)
	if err != nil || len(inbound) != sp.MaxFrameBytes-1 {
		t.Fatalf("invalid boundary probe %d %v", len(inbound), err)
	}
	oversized, err = sp.DecodeCommand(inbound)
	if err != nil {
		t.Fatal("boundary command must pass public schema", err)
	}
	following := nativeOfferCommand(t, v.Fence, "continue")
	responses := configureContentOperations(t, f, oversized, following)
	f.dao.Expect("SessionOperation", 6)
	f.dao.Expect("InsertSessionOperation", 2)
	f.dao.Expect("PendingSessionOperationCount", 2)
	f.dao.Expect("AcceptedSessionOperations", 1)
	f.dao.Expect("SetSessionOperationEpoch", 1)
	f.dao.Expect("SetSessionOperationReceipt", 2)
	_, _, cursor, err := f.s.BrowserPoll(f.BrowserPhase(ctx, nil), f.p, f.project, f.task, v.SessionID, "")
	if err != nil {
		t.Fatal(err)
	}
	for i, command := range []sp.Command{oversized, following} {
		responses.pending = i
		if _, err = f.s.Submit(f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1}), f.p, f.project, f.task, v.SessionID, command); err != nil {
			t.Fatal(err)
		}
		f.SelectSessionWrite(t)
		responses.useProposedResponse(command.OperationID, f.s.now().Add(time.Minute))
		responses.accepted = append(responses.accepted, command.OperationID)
	}
	offers, err := f.s.Poll(f.ControllerPhase(ctx, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 2, "LockCredential": 3, "ProjectAccess": 3, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 2, "SaveSession": 1}), v.ControllerFence)
	if err != nil || len(offers) != 1 {
		t.Fatalf("oversized envelope blocked following command: %d %v", len(offers), err)
	}
	f.SelectSessionWrite(t)
	if offers[0]["command"].(sp.Command).OperationID != following.OperationID {
		t.Fatal("oversized command was offered")
	}
	responses.useProposedResponse(oversized.OperationID, f.s.now().Add(time.Minute))
	responses.useProposedResponse(following.OperationID, f.s.now().Add(time.Minute))
	receipt, err := f.s.Operation(f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1}), f.p, f.project, f.task, v.SessionID, oversized.OperationID)
	if err != nil || receipt.State != "rejected" {
		t.Fatalf("oversized operation lacks definite refusal: %+v %v", receipt, err)
	}
	_, events, _, err := f.s.BrowserPoll(f.BrowserPhase(ctx, nil), f.p, f.project, f.task, v.SessionID, cursor)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range events {
		payload, ok := event["payload"].(map[string]any)
		if !ok || payload["operationId"] != oversized.OperationID || payload["state"] != "rejected" {
			continue
		}
		failure, ok := payload["error"].(map[string]any)
		if ok && failure["code"] == "payload_too_large" {
			found = true
		}
	}
	if !found {
		t.Fatal("live rejection omitted the size refusal reason")
	}
	// Refusal remains idempotent against the original canonical intent.
	repeated, err := f.s.Submit(f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1}), f.p, f.project, f.task, v.SessionID, oversized)
	if err != nil || repeated.State != "rejected" {
		t.Fatal("oversize refusal retry changed intent", err)
	}
}

func TestOfferBudgetDefersOnlyTheRemainingBatch(t *testing.T) {
	f, v := connectFixture(t)
	publishState(t, f, v, idleState())
	ctx := context.Background()
	var ids []string
	var commands []sp.Command
	for range 3 {
		c := nativeOfferCommand(t, v.Fence, strings.Repeat("<", 800000))
		ids = append(ids, c.OperationID)
		commands = append(commands, c)
	}
	responses := configureContentOperations(t, f, commands...)
	f.dao.Expect("SessionOperation", 7)
	f.dao.Expect("InsertSessionOperation", 3)
	f.dao.Expect("PendingSessionOperationCount", 3)
	f.dao.Expect("AcceptedSessionOperations", 2)
	f.dao.Expect("SetSessionOperationEpoch", 3)
	f.dao.Expect("SetSessionOperationReceipt", 3)
	for i, c := range commands {
		responses.pending = i
		if _, err := f.s.Submit(f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1}), f.p, f.project, f.task, v.SessionID, c); err != nil {
			t.Fatal(err)
		}
		f.SelectSessionWrite(t)
		responses.useProposedResponse(c.OperationID, f.s.now().Add(time.Minute))
	}
	for i, want := range []int{2, 1} {
		responses.accepted = ids
		offers, err := f.s.Poll(f.ControllerPhase(ctx, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": len(ids), "LockCredential": 1 + len(ids), "ProjectAccess": 1 + len(ids), "SetSessionOperationEpoch": want, "SetSessionOperationReceipt": want, "SaveSession": 1}), v.ControllerFence)
		if err != nil || len(offers) != want {
			t.Fatalf("poll %d: offers=%d err=%v", i, len(offers), err)
		}
		f.SelectSessionWrite(t)
		total := 0
		for _, offer := range offers {
			raw, _ := sp.MarshalWire(offer)
			total += len(raw)
			c := offer["command"].(sp.Command)
			responses.useProposedResponse(c.OperationID, f.s.now().Add(time.Minute))
			if c.OperationID != ids[0] {
				t.Fatal("offer order changed")
			}
			ids = ids[1:]
		}
		if total > sp.MaxFrameBytes {
			t.Fatal("offer batch exceeded budget")
		}
	}
	if len(ids) != 0 {
		t.Fatal("following batch starved")
	}
}
