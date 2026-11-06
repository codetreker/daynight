package mcp

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type safeInvitationLog struct {
	mu sync.Mutex
	bytes.Buffer
}

func (l *safeInvitationLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.Buffer.Write(p)
}
func (l *safeInvitationLog) text() string { l.mu.Lock(); defer l.mu.Unlock(); return l.Buffer.String() }

type unknownInvitationTeams struct {
	calls   int
	failure error
}

func (*unknownInvitationTeams) CreateInvitation(context.Context, model.Principal, string, string) (teamcore.MintedTeamInvitation, error) {
	panic("unexpected create")
}
func (*unknownInvitationTeams) ListInvitationPage(context.Context, model.Principal, string, model.PageRequest) (teamcore.InvitationPage, error) {
	panic("unexpected list")
}
func (*unknownInvitationTeams) RevokeInvitation(context.Context, model.Principal, string, string, string) (bool, error) {
	panic("unexpected revoke")
}
func (*unknownInvitationTeams) InspectInvitation(context.Context, model.Principal, string) (teamcore.TeamInvitationInspection, error) {
	panic("unexpected inspect")
}
func (s *unknownInvitationTeams) AcceptInvitation(context.Context, model.Principal, string, string) (teamcore.TeamInvitationAcceptance, error) {
	s.calls++
	return teamcore.TeamInvitationAcceptance{}, s.failure
}

type unknownInvitationProjects struct{}

func (unknownInvitationProjects) InspectInvitation(context.Context, model.Principal, string) (projectcore.InvitationInspection, error) {
	panic("unexpected project inspect")
}
func (unknownInvitationProjects) AcceptInvitation(context.Context, model.Principal, string, string) (projectcore.InvitationAcceptance, error) {
	panic("unexpected project accept")
}

func TestMCPInvitationUnknownOutcomeIsNotReplayedOrDisclosed(t *testing.T) {
	var logs safeInvitationLog
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	entry, err := New(testAuthenticator{}, "https://daynight.test", nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	secret := "dnteam_" + strings.Repeat("A", 43)
	link := "https://daynight.test/team-invitations#" + secret
	service := &unknownInvitationTeams{failure: &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: errors.New("private " + secret)}}
	if err := RegisterInvitationTools(entry, &identity.Identity{}, service, unknownInvitationProjects{}, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpx.RequestLogging(logger, entry))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := entry.Shutdown(ctx); err != nil {
			t.Error(err)
		}
		server.Close()
	})
	fixture := &entryFixture{entry: entry, server: server}
	client := fixture.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "invitation_accept", Arguments: map[string]any{"link": link, "confirm": true}})
	if err != nil || !result.IsError {
		t.Fatalf("accept failure was not returned as a tool error: %v", err)
	}
	failure := object(t, structured(t, result)["error"])
	if failure["writeOutcome"] != "unknown" || failure["phase"] != "commit" || failure["requestId"] != "test-request" {
		t.Fatalf("completion facts: %#v", failure)
	}
	if service.calls != 1 {
		t.Fatalf("accept called %d times", service.calls)
	}
	if strings.Contains(logs.text(), secret) || strings.Contains(result.Content[0].(*sdk.TextContent).Text, secret) || strings.Contains(failure["message"].(string), secret) {
		t.Fatal("invitation secret appeared in logs or error")
	}
}
