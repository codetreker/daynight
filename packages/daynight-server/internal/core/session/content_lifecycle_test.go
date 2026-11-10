package session

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestStopCancelsAndWaitsForOnlineContent(t *testing.T) {
	f, snapshot := connectFixture(t)
	syncContent(t, f, snapshot)
	result := make(chan error, 1)
	go func() {
		phase := contentReadPhase(f, context.Background(), 1)
		_, err := f.s.Timeline(phase, f.p, f.project, f.task, snapshot.SessionID, "tail", "", 10)
		f.dao.FinishContext(phase)
		result <- err
	}()
	_ = nextContent(t, f, snapshot)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := f.s.Engine.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		var refusal *model.Fault
		if !errors.As(err, &refusal) || refusal.Code != "service_unavailable" {
			t.Fatalf("content error = %v", err)
		}
	case <-ctx.Done():
		t.Fatal("content work did not finish before Stop returned")
	}
	f.s.content.mu.Lock()
	defer f.s.content.mu.Unlock()
	if len(f.s.content.pending) != 0 {
		t.Fatal("stopped content request was not removed")
	}
}

func TestStopCancelsMultichunkResource(t *testing.T) {
	f, snapshot := connectFixture(t)
	syncContent(t, f, snapshot)
	body := []byte("ab")
	hash := sha256.Sum256(body)
	digest, size, media := hex.EncodeToString(hash[:]), "2", "text/plain"
	descriptor := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "local.txt", ByteLength: &size, SHA256: &digest, MediaType: &media}
	result := make(chan error, 1)
	go func() {
		phase := contentReadPhase(f, context.Background(), 3)
		_, _, err := f.s.Resource(phase, f.p, f.project, f.task, snapshot.SessionID, descriptor.ResourceID)
		f.dao.FinishContext(phase)
		result <- err
	}()
	request := nextContent(t, f, snapshot)
	replyContent(t, f, snapshot, request, &sp.ContentResult{Kind: "resource", Resource: &descriptor, Offset: "0", Data: base64.StdEncoding.EncodeToString(body[:1]), EOF: false}, nil)
	request = nextContent(t, f, snapshot)
	if request["offset"] != "1" {
		t.Fatalf("second chunk offset = %v", request["offset"])
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := f.s.Engine.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		var refusal *model.Fault
		if !errors.As(err, &refusal) || refusal.Code != "service_unavailable" {
			t.Fatalf("resource error = %v", err)
		}
	case <-ctx.Done():
		t.Fatal("resource work did not finish before Stop returned")
	}
	f.s.content.mu.Lock()
	defer f.s.content.mu.Unlock()
	if len(f.s.content.pending) != 0 {
		t.Fatal("stopped resource request was not removed")
	}
}
