package session

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func qualifiedImageReport() (sp.Snapshot, sp.ProviderImageCapabilities) {
	native, modelID, revision := "original-native", "confirmed-model", "3"
	snapshot := sp.Snapshot{ContentRevision: 2, Identity: sp.Identity{NativeSessionID: &native}, Controls: &sp.Controls{Revision: revision, Settings: []sp.Setting{{Category: "model", Value: &modelID}}}}
	provider := sp.ProviderImageCapabilities{Revision: "7", ExpectedNativeSessionID: &native, ModelID: &modelID, ControlsRevision: &revision, Send: "supported", Steer: "unsupported", InputMediaTypes: []string{"image/webp", "image/png"}, MaxImageBytes: "1000", MaxMessageImageBytes: "1500", MaxImagesPerMessage: 2, Geometry: sp.ImageGeometry{Version: 1, Known: true, MaxWidth: 30, MaxHeight: 40, MaxPixels: 1000, MaxFrames: 1}}
	return snapshot, provider
}

func TestEffectiveImageCapabilitiesRequiresQualifiedIdentityAndComponents(t *testing.T) {
	for _, kind := range []string{"qualified", "components", "old content", "missing report", "native", "controls", "model", "unknown model", "controls error", "geometry version", "unknown geometry", "empty media", "zero bytes", "zero count", "invalid revision", "disabled contradiction"} {
		t.Run(kind, func(t *testing.T) {
			snapshot, provider := qualifiedImageReport()
			report, ready := &provider, true
			other := "different"
			switch kind {
			case "components":
				ready = false
			case "old content":
				snapshot.ContentRevision = 0
			case "missing report":
				report = nil
			case "native":
				provider.ExpectedNativeSessionID = &other
			case "controls":
				provider.ControlsRevision = nil
			case "model":
				provider.ModelID = &other
			case "unknown model":
				provider.ModelID = nil
			case "controls error":
				snapshot.Controls.SettingsError = &other
			case "geometry version":
				provider.Geometry.Version = 2
			case "unknown geometry":
				provider.Geometry = sp.ImageGeometry{Version: 1}
			case "empty media":
				provider.InputMediaTypes = []string{}
			case "zero bytes":
				provider.MaxImageBytes = "0"
			case "zero count":
				provider.MaxImagesPerMessage = 0
			case "invalid revision":
				provider.Revision = "-1"
			case "disabled contradiction":
				reason := "profile_disabled"
				provider.ReasonCode = &reason
			}
			caps := effectiveImageCapabilities(snapshot, report, ready)
			if kind == "qualified" {
				if caps.Send != "supported" || caps.Steer != "unsupported" || caps.ProviderRevision != "7" || caps.MaxImageBytes != "1000" || caps.MaxMessageImageBytes != "1500" || caps.MaxImagesPerMessage != 2 || caps.Geometry != provider.Geometry || !reflect.DeepEqual(caps.InputMediaTypes, []string{"image/png", "image/webp"}) {
					t.Fatalf("qualified limits changed: %+v", caps)
				}
			} else if caps.Send == "supported" || caps.Steer == "supported" || caps.ReasonCode == nil {
				t.Fatalf("unqualified report enabled input: %+v", caps)
			}
			// Every result must remain a valid public capability value.
			var wire map[string]json.RawMessage
			_ = json.Unmarshal(encode(caps), &wire)
			delete(wire, "providerRevision")
			if _, err := sp.DecodeProviderImageCapabilities(encode(wire)); err != nil {
				t.Fatalf("invalid effective capability: %+v: %v", caps, err)
			}
		})
	}
}

func TestEffectiveImageCapabilitiesPreservesIndependentProviderStates(t *testing.T) {
	for _, kind := range []string{"send only", "steer only", "unknown", "unresolved", "disabled", "message tighter", "no controls"} {
		t.Run(kind, func(t *testing.T) {
			snapshot, provider := qualifiedImageReport()
			switch kind {
			case "steer only":
				provider.Send, provider.Steer = "unsupported", "supported"
			case "unknown":
				reason := "capability_unknown"
				provider.Send, provider.Steer, provider.ReasonCode = "unknown", "unknown", &reason
			case "unresolved":
				reason := "capability_unknown"
				provider.Send, provider.Steer, provider.ReasonCode = "unknown", "unknown", &reason
				provider.ModelID = nil
				provider.Geometry = sp.ImageGeometry{Version: 1}
				provider.InputMediaTypes = []string{}
				provider.MaxImageBytes, provider.MaxMessageImageBytes, provider.MaxImagesPerMessage = "0", "0", 0
			case "disabled":
				reason := "profile_disabled"
				provider.Send, provider.Steer, provider.ReasonCode = "unsupported", "unsupported", &reason
			case "message tighter":
				provider.MaxMessageImageBytes = "500"
			case "no controls":
				snapshot.Controls, provider.ControlsRevision = nil, nil
			}
			caps := effectiveImageCapabilities(snapshot, &provider, true)
			if caps.Send != provider.Send || caps.Steer != provider.Steer || !reflect.DeepEqual(caps.ReasonCode, provider.ReasonCode) {
				t.Fatalf("provider states changed: %+v", caps)
			}
			if kind == "message tighter" && caps.MaxImageBytes != "500" {
				t.Fatal("single image exceeded whole-message limit")
			}
		})
	}
}

func TestApplyStateOwnsImageRevisionAndUsesSameFrameControls(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	snapshot, provider := qualifiedImageReport()
	f.r.Snapshot.Identity.NativeSessionID = snapshot.Identity.NativeSessionID
	f.r.Snapshot.InitialInputState = "not_required"
	f.s.files = f.files.Storage
	tx := &operationTx{dao: &imageIntentDAO{imageRuleDAO: f.d}, op: &Operation{}}
	state := sp.State{NativeSessionID: snapshot.Identity.NativeSessionID, InitialInputState: "not_required", Controls: snapshot.Controls, ProviderImages: &provider, Capabilities: sp.Capabilities{Send: true, Images: &sp.ImageCapabilities{Revision: "999999"}}}
	for i := 0; i < 2; i++ {
		if err := f.s.applyState(t.Context(), tx, f.r, state); err != nil {
			t.Fatal(err)
		}
		caps := f.r.Snapshot.Capabilities.Images
		if caps.Revision != "3" || caps.Send != "supported" || caps.ControlsRevision == nil || *caps.ControlsRevision != "3" {
			t.Fatalf("frame lost effective identity: %+v", caps)
		}
	}
	provider.MaxImageBytes = "500"
	provider.Revision = "8"
	if err := f.s.applyState(t.Context(), tx, f.r, state); err != nil {
		t.Fatal(err)
	}
	if caps := f.r.Snapshot.Capabilities.Images; caps.Revision != "4" || caps.MaxImageBytes != "500" {
		t.Fatalf("changed qualification did not advance: %+v", caps)
	}
}

func TestImageCapabilityRefreshRequiresInstalledComponents(t *testing.T) {
	for _, kind := range []string{"ready", "decoder", "files", "resource cleanup", "upload cleanup", "intent store", "archive store", "resource store"} {
		t.Run(kind, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			snapshot, provider := qualifiedImageReport()
			f.r.Snapshot.Identity.NativeSessionID, f.r.Snapshot.Controls = snapshot.Identity.NativeSessionID, snapshot.Controls
			f.s.files = f.files.Storage
			var dao store.SessionDAO = &imageIntentDAO{imageRuleDAO: f.d}
			switch kind {
			case "decoder":
				f.s.SetImageDecoder(nil)
			case "files":
				f.s.files = nil
			case "resource cleanup":
				f.s.files = f.files
			case "upload cleanup":
				f.s.files = struct {
					filestorage.Storage
					filestorage.ResourceStorage
				}{f.files.Storage, f.files.Storage.(filestorage.ResourceStorage)}
			case "intent store":
				dao = f.d
			case "archive store":
				dao = struct {
					store.SessionDAO
					store.SessionResourceDAO
					store.SessionIntentDAO
				}{f.d, f.d, dao.(store.SessionIntentDAO)}
			case "resource store":
				dao = struct{ store.SessionDAO }{f.d}
			}
			err := f.s.refreshImageState(t.Context(), &operationTx{dao: dao}, f.r, &provider)
			if kind == "resource store" {
				if err == nil {
					t.Fatal("missing resource facts accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			caps := f.r.Snapshot.Capabilities.Images
			if (caps.Send == "supported") != (kind == "ready") || kind != "ready" && (caps.ReasonCode == nil || *caps.ReasonCode != "component_unsupported") {
				t.Fatalf("component qualification: %+v", caps)
			}
		})
	}
}

func TestImageInputAdmissionRequiresCurrentSealableHistory(t *testing.T) {
	for _, kind := range []string{"current", "missing", "unsealable", "epoch", "source", "transition"} {
		t.Run(kind, func(t *testing.T) {
			f, command, _ := imageIntentFixture(t)
			var ledger archiveLedger
			if err := json.Unmarshal(f.d.bundle.Ledger, &ledger); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "missing":
				f.d.bundle.SessionID = ""
			case "unsealable":
				ledger.Sealable = false
			case "epoch":
				ledger.HistoryEpoch = "retired"
			case "source":
				f.r.SourceSeq++
			case "transition":
				ledger.TargetSourceEpoch = "replacement"
			}
			f.d.bundle.Ledger = encode(ledger)
			err := f.s.authorizeImages(t.Context(), &operationTx{dao: f.d}, f.r, command)
			if kind == "current" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			var refusal *model.Fault
			if !errors.As(err, &refusal) || refusal.Code != "capability_changed" && refusal.Code != "component_unsupported" {
				t.Fatalf("history was not rejected: %v", err)
			}
		})
	}
}

type imageReplayDAO struct {
	store.SessionDAO
	operation store.SessionOperation
}

func (d imageReplayDAO) SessionOperation(context.Context, string, string) (store.SessionOperation, error) {
	return d.operation, nil
}

func TestExistingImageOperationPrecedesChangedHistoryAndCapabilities(t *testing.T) {
	f, command, _ := imageIntentFixture(t)
	row := store.SessionOperation{Command: command, Hash: commandHash(command), Actor: f.p, Receipt: sp.Operation{State: "unknown", OperationID: command.OperationID}}
	f.s.browserRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ BrowserPurpose, fn func(*Access) error) error {
		return fn(&Access{tx: &operationTx{dao: imageReplayDAO{operation: row}, op: &Operation{live: map[string]*liveSession{command.SessionID: nil}}}, record: f.r, write: true})
	}
	f.r.Snapshot.Capabilities.Images = nil
	f.r.Live = nil
	out, err := f.s.Submit(t.Context(), f.p, "", "", command.SessionID, command)
	if err != nil || out.State != "unknown" || out.OperationID != command.OperationID {
		t.Fatalf("existing fact changed: %+v %v", out, err)
	}
}
