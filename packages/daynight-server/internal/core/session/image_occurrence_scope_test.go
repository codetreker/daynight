package session

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestImageRetryScopePrecedesAnyMutation(t *testing.T) {
	for _, missing := range []scopepolicy.Operation{scopepolicy.SessionControl, scopepolicy.SessionRead} {
		t.Run(string(missing), func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			c := failOccurrenceFixture(f, registerOccurrenceFixture(t, f), "invalid_image")
			f.d.rateCalls = nil
			denied := &model.Fault{Code: "insufficient_scope", Message: "denied"}
			var calls []scopepolicy.Operation
			f.s.SetCommandAdmission(func(_ context.Context, _ store.SessionScope, p model.Principal, op scopepolicy.Operation) error {
				if p != f.p {
					t.Fatal("wrong actor")
				}
				calls = append(calls, op)
				if op == missing {
					return denied
				}
				return nil
			})
			out, err := f.s.RetryImageOccurrence(t.Context(), f.p, "", "", c.SessionID, c.Request.Occurrence.ImageID)
			want := []scopepolicy.Operation{scopepolicy.SessionControl}
			if missing == scopepolicy.SessionRead {
				want = append(want, scopepolicy.SessionRead)
			}
			if !errors.Is(err, denied) || !reflect.DeepEqual(calls, want) || out.Capture.CaptureID != "" || len(f.d.rateCalls) != 0 || len(f.d.media) != 0 || !reflect.DeepEqual(f.d.captures[c.Request.CaptureID], c) {
				t.Fatalf("refusal changed retry: out=%+v err=%v calls=%v rates=%v", out, err, calls, f.d.rateCalls)
			}
		})
	}
}

func TestImageStatusScopeAndRetryProjection(t *testing.T) {
	for _, tc := range []struct {
		name    string
		missing scopepolicy.Operation
		failure error
		action  string
		wantErr bool
	}{
		{"read denied", scopepolicy.SessionRead, &model.Fault{Code: "insufficient_scope"}, "none", true},
		{"control denied", scopepolicy.SessionControl, &model.Fault{Code: "insufficient_scope"}, "none", false},
		{"control lookup failed", scopepolicy.SessionControl, errors.New("policy lookup failed"), "none", true},
		{"both permitted", "", nil, "retry_source", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			c := failOccurrenceFixture(f, registerOccurrenceFixture(t, f), "invalid_image")
			f.d.rateCalls = nil
			f.s.SetCommandAdmission(func(_ context.Context, _ store.SessionScope, p model.Principal, op scopepolicy.Operation) error {
				if p != f.p {
					t.Fatal("wrong actor")
				}
				if op == tc.missing {
					return tc.failure
				}
				return nil
			})
			out, err := f.s.GetImageOccurrence(t.Context(), f.p, "", "", c.SessionID, c.Request.Occurrence.ImageID)
			if tc.wantErr {
				if !errors.Is(err, tc.failure) {
					t.Fatalf("got %v", err)
				}
				if tc.missing == scopepolicy.SessionRead && len(f.d.rateCalls) != 0 {
					t.Fatal("read refusal charged rate")
				}
			} else if err != nil || out.State != "failed" || out.Action != tc.action {
				t.Fatalf("status=%+v err=%v", out, err)
			}
			if len(f.d.media) != 0 || !reflect.DeepEqual(f.d.captures[c.Request.CaptureID], c) {
				t.Fatal("status created source work")
			}
		})
	}
}

func TestImageReadSettlesPriorGenerationAttemptWithoutControl(t *testing.T) {
	for _, success := range []bool{false, true} {
		t.Run(map[bool]string{false: "failure", true: "success"}[success], func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("image"))
			c := registerOccurrenceFixture(t, f)
			c.Receipt.AttemptID = uuid.NewString()
			f.d.captures[c.Request.CaptureID] = c
			f.r.Snapshot.ExecutionGeneration = "2"
			fence := f.r.Snapshot.ControllerFence
			fence.ExecutionGeneration = "1"
			row := store.SessionMediaRequest{SessionID: c.SessionID, RequestID: mediaIdentity(c.Receipt.AttemptID, "retry_capture"), Action: "retry_capture", Fence: fence, Complete: true}
			if success {
				row.Result = encode(sp.ValidatedImage{MediaType: "image/png", ByteLength: "5", SHA256: imageBytesHash([]byte("image")), Width: 2, Height: 3, FrameCount: 1})
			} else {
				row.Error = &sp.ImageError{Code: "invalid_image", Message: "Original failed."}
			}
			f.d.media[row.RequestID] = row
			op := &Operation{}
			f.s.browserRun = func(ctx context.Context, actor model.Principal, _, _, id string, _ BrowserPurpose, work func(*Access) error) error {
				if actor != f.p || id != c.SessionID {
					t.Fatal("wrong Session identity")
				}
				return work(&Access{tx: &operationTx{dao: f.d, op: op}, record: f.r, write: true})
			}
			f.s.SetCommandAdmission(func(_ context.Context, _ store.SessionScope, _ model.Principal, op scopepolicy.Operation) error {
				if op == scopepolicy.SessionControl {
					return &model.Fault{Code: "insufficient_scope"}
				}
				return nil
			})
			out, err := f.s.GetImageOccurrence(t.Context(), f.p, "", "", c.SessionID, c.Request.Occurrence.ImageID)
			settled := f.d.captures[c.Request.CaptureID]
			if err != nil || settled.Receipt.AttemptID != c.Receipt.AttemptID || !reflect.DeepEqual(settled.Request, c.Request) || len(f.d.media) != 1 {
				t.Fatalf("settlement: %+v %v", settled, err)
			}
			if success && (out.State != "pending" || settled.Receipt.State != "copying") {
				t.Fatalf("success: %+v %+v", out, settled)
			}
			if success && len(op.committed) == 0 {
				t.Fatal("copy continuation was not scheduled after commit")
			}
			if !success && (out.State != "failed" || out.Action != "none" || settled.Receipt.State != "failed") {
				t.Fatalf("failure: %+v %+v", out, settled)
			}
		})
	}
}
