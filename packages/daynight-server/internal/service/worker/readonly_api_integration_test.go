package worker

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	oauthcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

func TestReadOnlyAPIUsesCurrentFamilyBeforeDeliveryAndReturn(t *testing.T) {
	for _, stage := range []string{"delivery", "return"} {
		t.Run(stage, func(t *testing.T) {
			_, db, _, owner := testsupport.ProjectService(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			workerID := uuid.NewString()
			if _, err := NewWorkers(db).Report(ctx, owner, workerID, serviceWorkerReport()); err != nil {
				t.Fatal(err)
			}
			hash := sha256.Sum256([]byte(uuid.NewString()))
			pat := model.PersonalAccessToken{ID: uuid.NewString(), UserID: owner.UserID, Name: "readonly producer", TokenHash: hash[:], CreatedAt: time.Now()}
			if _, err := db.WriteIdentity(ctx, func(s store.IdentityScope) error { return s.IdentityDAO().InsertPAT(ctx, pat) }); err != nil {
				t.Fatal(err)
			}
			producer := model.Principal{Kind: model.PATCredential, UserID: owner.UserID, CredentialID: pat.ID}
			issuer, err := oauthservice.NewAPIIssuer(db, "https://readonly.example")
			if err != nil {
				t.Fatal(err)
			}
			issue := func() (oauthcore.IssuedFamily, model.Principal) {
				issued, err := issuer.Issue(ctx, owner.UserID)
				if err != nil {
					t.Fatal(err)
				}
				return issued, model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID, CredentialID: issued.AccessID}
			}
			_, valid := issue()
			family, revoked := issue()
			authority := oauthservice.NewAuthenticator(db)
			authority.SetOrigin("https://readonly.example")
			beforeReturn, resumeReturn := make(chan struct{}), make(chan struct{})
			var mu sync.Mutex
			revokedCalls := 0
			broker := NewReadOnly(db, func(ctx context.Context, principal model.Principal) error {
				if principal == revoked {
					mu.Lock()
					revokedCalls++
					last := stage == "return" && revokedCalls == 3
					mu.Unlock()
					if last {
						close(beforeReturn)
						select {
						case <-resumeReturn:
						case <-ctx.Done():
							return ctx.Err()
						}
					}
				}
				return authority.RecheckAPIAccess(ctx, principal)
			})
			defer broker.Close()
			connection, err := broker.Connect(ctx, producer, workerID, ro.Hello{Type: "hello", Protocol: ro.Protocol, CapabilityGeneration: uuid.NewString(), Operations: []string{"directory.list"}})
			if err != nil {
				t.Fatal(err)
			}
			type outcome struct {
				result ro.Message
				err    error
			}
			start := func(principal model.Principal) (<-chan outcome, ro.Message) {
				answer := make(chan outcome, 1)
				go func() {
					result, err := broker.Request(ctx, principal, workerID, readOnlyRequest())
					answer <- outcome{result, err}
				}()
				select {
				case request := <-connection.Messages:
					return answer, request
				case <-ctx.Done():
					t.Fatal("request not dispatched", ctx.Err())
					return nil, ro.Message{}
				}
			}
			deliver := func(request ro.Message) {
				result := ro.Message{Fence: request.Fence, Type: "result", RequestID: request.RequestID, Result: json.RawMessage(`{"path":"/repo","parentPath":null,"entries":[],"nextCursor":null}`)}
				if err := broker.Deliver(ctx, connection, result); err != nil {
					t.Fatal(err)
				}
			}
			await := func(answer <-chan outcome, want string) {
				select {
				case got := <-answer:
					if want == "" {
						if got.err != nil || len(got.result.Result) == 0 {
							t.Fatalf("valid API request: %+v", got)
						}
					} else if ro.ErrorCode(got.err) != want || len(got.result.Result) != 0 {
						t.Fatalf("revoked API result: %+v", got)
					}
				case <-ctx.Done():
					t.Fatal("request did not finish", ctx.Err())
				}
			}
			revoke := func() {
				if changed, err := oauthcore.NewGrantLifecycle(db).RevokeOwnerGrant(ctx, owner.UserID, family.Grant.ID); err != nil || !changed {
					t.Fatalf("revoke family: %v %v", changed, err)
				}
			}
			answer, request := start(valid)
			deliver(request)
			await(answer, "")
			answer, request = start(revoked)
			if stage == "delivery" {
				revoke()
			}
			deliver(request)
			if stage == "return" {
				select {
				case <-beforeReturn:
				case <-ctx.Done():
					t.Fatal("return admission was not reached", ctx.Err())
				}
				revoke()
				close(resumeReturn)
			}
			await(answer, "unauthenticated")
			if err := authority.RecheckAPIAccess(ctx, revoked); ro.ErrorCode(err) != "unauthenticated" {
				t.Fatalf("revoked family retained authority: %v", err)
			}
			answer, request = start(valid)
			deliver(request)
			await(answer, "")
			if err := broker.Check(ctx, connection); err != nil {
				t.Fatalf("revocation invalidated producer PAT channel: %v", err)
			}
		})
	}
}
