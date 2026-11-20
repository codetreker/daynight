package bot

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"math"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func recoveryRuleBot() model.Bot {
	session, execution := "session", "execution"
	return model.Bot{ID: "bot", OwnerUserID: "owner", WorkerID: "worker", Version: 2,
		SessionID: &session, TestExecutionID: &execution, RoleConfiguration: &model.BotRoleConfiguration{},
		Recovery: &model.BotRecovery{WorkerID: "worker", ServiceOrigin: "https://daynight.example", MachineID: "machine", MachineName: "Host", IdentityHash: bytes.Repeat([]byte{42}, sha256.Size), HostingGeneration: 4}}
}

func recoveryFault(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}

func TestRecoveryAuthorizationRequiresOwnerOriginAndProtectedIdentity(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*model.Bot, *string, *string, *[]byte)
		code   string
	}{
		{"owner", func(_ *model.Bot, owner, _ *string, _ *[]byte) { *owner = "other" }, "forbidden"},
		{"origin", func(_ *model.Bot, _, origin *string, _ *[]byte) { *origin = "https://other.example" }, "forbidden"},
		{"proof", func(_ *model.Bot, _, _ *string, hash *[]byte) { (*hash)[0]++ }, "forbidden"},
		{"short proof", func(_ *model.Bot, _, _ *string, hash *[]byte) { *hash = (*hash)[:31] }, "forbidden"},
		{"missing stored proof", func(b *model.Bot, _, _ *string, _ *[]byte) { b.Recovery.IdentityHash = nil }, "forbidden"},
		{"not registered", func(b *model.Bot, _, _ *string, _ *[]byte) { b.Recovery = nil }, "upgrade_required"},
		{"deleted", func(b *model.Bot, _, _ *string, _ *[]byte) { b.Deletion = &model.BotDeletion{} }, "resource_conflict"},
	} {
		t.Run(test.name, func(t *testing.T) {
			bot := recoveryRuleBot()
			owner, origin, hash := bot.OwnerUserID, bot.Recovery.ServiceOrigin, bytes.Clone(bot.Recovery.IdentityHash)
			test.change(&bot, &owner, &origin, &hash)
			recoveryFault(t, AuthorizeRecovery(bot, owner, origin, hash), test.code)
		})
	}
	bot := recoveryRuleBot()
	if err := AuthorizeRecovery(bot, bot.OwnerUserID, bot.Recovery.ServiceOrigin, bot.Recovery.IdentityHash); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(bot.Recovery)
	if err != nil || bytes.Contains(encoded, []byte("IdentityHash")) {
		t.Fatalf("recovery hash leaked into JSON: %s, %v", encoded, err)
	}
}

func TestRecoveryRegistrationRequiresOriginalBoundRuntime(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*model.Bot)
		code   string
	}{
		{"registered", func(b *model.Bot) { b.Recovery = recoveryRuleBot().Recovery }, "upgrade_required"},
		{"unbound", func(b *model.Bot) { b.SessionID = nil }, "resource_conflict"},
		{"missing execution", func(b *model.Bot) { b.TestExecutionID = nil }, "resource_conflict"},
		{"missing role", func(b *model.Bot) { b.RoleConfiguration = nil }, "resource_conflict"},
		{"exhausted", func(b *model.Bot) { b.Version = math.MaxInt64 }, "version_exhausted"},
		{"other worker", func(b *model.Bot) { b.WorkerID = "other" }, "forbidden"},
	} {
		t.Run(test.name, func(t *testing.T) {
			bot := recoveryRuleBot()
			bot.Recovery = nil
			test.change(&bot)
			recoveryFault(t, PrepareRecoveryRegistration(bot, "owner", "worker"), test.code)
		})
	}
	bot := recoveryRuleBot()
	bot.Recovery = nil
	if err := PrepareRecoveryRegistration(bot, "owner", "worker"); err != nil {
		t.Fatal(err)
	}
}

func TestRecoveryTakeoverRequiresExactGenerationAndOriginalMachine(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*model.Bot, *int64, *model.WorkerMachine)
		code   string
	}{
		{"unregistered", func(b *model.Bot, _ *int64, _ *model.WorkerMachine) { b.Recovery = nil }, "resource_conflict"},
		{"stale", func(_ *model.Bot, g *int64, _ *model.WorkerMachine) { *g-- }, "resource_conflict"},
		{"zero", func(_ *model.Bot, g *int64, _ *model.WorkerMachine) { *g = 0 }, "resource_conflict"},
		{"different machine", func(_ *model.Bot, _ *int64, m *model.WorkerMachine) { m.ID = "other" }, "resource_conflict"},
		{"missing machine", func(_ *model.Bot, _ *int64, m *model.WorkerMachine) { m.ID = "" }, "resource_conflict"},
		{"unbound", func(b *model.Bot, _ *int64, _ *model.WorkerMachine) { b.SessionID = nil }, "resource_conflict"},
		{"missing execution", func(b *model.Bot, _ *int64, _ *model.WorkerMachine) { b.TestExecutionID = nil }, "resource_conflict"},
		{"version exhausted", func(b *model.Bot, _ *int64, _ *model.WorkerMachine) { b.Version = math.MaxInt64 }, "version_exhausted"},
		{"generation exhausted", func(b *model.Bot, g *int64, _ *model.WorkerMachine) {
			*g = math.MaxInt64
			b.Recovery.HostingGeneration = *g
		}, "version_exhausted"},
	} {
		t.Run(test.name, func(t *testing.T) {
			bot, generation, machine := recoveryRuleBot(), int64(4), model.WorkerMachine{ID: "machine", Name: "Renamed"}
			test.change(&bot, &generation, &machine)
			recoveryFault(t, PrepareRecoveryTakeover(bot, generation, machine), test.code)
		})
	}
	bot := recoveryRuleBot()
	if err := PrepareRecoveryTakeover(bot, 4, model.WorkerMachine{ID: "machine", Name: "Renamed"}); err != nil {
		t.Fatal(err)
	}
	// Even the same Worker must use the generation-bearing runtime after enrollment.
	recoveryFault(t, AuthorizeRuntime(bot, "owner", "worker"), "upgrade_required")
	bot.Version, bot.Recovery.HostingGeneration = math.MaxInt64, math.MaxInt64
	if err := CheckRecoveryHosting(bot, math.MaxInt64, model.WorkerMachine{ID: "machine"}); err != nil {
		t.Fatalf("non-advancing hosting check rejected maximum version: %v", err)
	}
}

func TestRecoveryCleanupBelongsToCurrentHostAndOriginalSessionStopProof(t *testing.T) {
	bot := recoveryRuleBot()
	bot.Recovery.WorkerID = "replacement"
	bot.Deletion = NewDeletion(store.DeleteBot{Version: bot.Version, DeletionID: "delete"})
	result := model.BotCleanupResult{State: "completed"}
	if _, _, err := PrepareWorkerCleanup(bot, "worker", "delete", result, "digest"); err == nil {
		t.Fatal("original definition Worker accepted a current-host cleanup receipt")
	}
	change, proof, err := PrepareWorkerCleanup(bot, "replacement", "delete", result, "digest")
	if err != nil || !change || !proof {
		t.Fatalf("current host must still provide original Session stop proof: %t %t %v", change, proof, err)
	}
}
