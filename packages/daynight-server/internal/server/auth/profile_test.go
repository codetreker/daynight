package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
)

func profileHTTP(t *testing.T, operation func(context.Context, model.Principal, model.UserProfilePatch) (model.User, error)) http.Handler {
	t.Helper()
	return profileHTTPLogged(t, operation, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func profileHTTPLogged(t *testing.T, operation func(context.Context, model.Principal, model.UserProfilePatch) (model.User, error), logger *slog.Logger) http.Handler {
	t.Helper()
	identity := &strictIdentity{t: t, callback: func() string { return "https://daynight.example/auth/callback" }, authenticate: func(_ context.Context, kind model.CredentialKind, secret string) (model.Principal, error) {
		if secret != "valid" {
			return model.Principal{}, Failure()
		}
		return model.Principal{UserID: "profile-user", CredentialID: "profile-credential", Kind: kind}, nil
	}, patchUser: operation}
	auth, err := NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	auth.RegisterRoutes(mux)
	return mux
}

func profileRequest(handler http.Handler, body, query, media string, cookie bool, origin string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/me"+query, strings.NewReader(body))
	req.Header.Set("Content-Type", media)
	if cookie {
		req.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: "valid"})
	} else {
		req.Header.Set("Authorization", "Bearer valid")
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	return w
}

func TestPatchMeProtocol(t *testing.T) {
	for _, cookie := range []bool{false, true} {
		t.Run(map[bool]string{false: "PAT", true: "Cookie"}[cookie], func(t *testing.T) {
			calls := 0
			name, email, teamName := "literal <name>\n", "kept@example.test", "Personal"
			user := model.User{ID: "profile-user", Name: &name, Email: &email, PersonalTeam: model.TeamRef{ID: "personal-team", Kind: "personal", Name: &teamName}}
			h := profileHTTP(t, func(ctx context.Context, p model.Principal, patch model.UserProfilePatch) (model.User, error) {
				calls++
				if p.UserID != "profile-user" || p.CredentialID != "profile-credential" || p.Kind != map[bool]model.CredentialKind{false: model.PATCredential, true: model.SessionCredential}[cookie] {
					t.Fatalf("principal=%+v", p)
				}
				if !patch.Name.Present || patch.Name.Value == nil || *patch.Name.Value != name || !patch.AvatarURL.Present || patch.AvatarURL.Value != nil {
					t.Fatalf("patch=%+v", patch)
				}
				deadline, ok := ctx.Deadline()
				remaining := time.Until(deadline)
				if !ok || remaining <= 14*time.Second || remaining > 15*time.Second {
					t.Fatalf("deadline remaining %s", remaining)
				}
				return user, nil
			})
			w := profileRequest(h, `{"name":"literal <name>\n","avatarUrl":null}`, "", "application/json", cookie, "https://daynight.example")
			var got api.User
			if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 || calls != 1 || !reflect.DeepEqual(got, userResponse(user)) || w.Header().Get("Daynight-User-ID") != user.ID || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("ETag") != "" {
				t.Fatalf("status=%d calls=%d headers=%v body=%s", w.Code, calls, w.Header(), w.Body.String())
			}
		})
	}
}

func TestPatchMeRejectsInputBeforeOperation(t *testing.T) {
	for _, tc := range []struct {
		name, body, query, media string
		status                   int
	}{
		{"empty", `{}`, "", "application/json", 400},
		{"unknown", `{"email":null}`, "", "application/json", 400},
		{"duplicate", `{"name":"a","name":"b"}`, "", "application/json", 400},
		{"wrong_type", `{"name":42}`, "", "application/json", 400},
		{"array", `[]`, "", "application/json", 400},
		{"trailing", `{"name":null}{}`, "", "application/json", 400},
		{"surrogate", `{"name":"\ud800"}`, "", "application/json", 400},
		{"nul", `{"name":"\u0000"}`, "", "application/json", 400},
		{"invalid_utf8", "{\"name\":\"\xff\"}", "", "application/json", 400},
		{"query", `{"name":null}`, "?version=1", "application/json", 400},
		{"media", `{"name":null}`, "", "text/plain", 400},
		{"body_limit", `{"avatarUrl":"` + strings.Repeat("a", 1<<20) + `"}`, "", "application/json", 413},
		{"name_limit", `{"name":"` + strings.Repeat("a", 1025) + `"}`, "", "application/json", 400},
		{"avatar_limit", `{"avatarUrl":"` + strings.Repeat("a", (512<<10)+1) + `"}`, "", "application/json", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			h := profileHTTP(t, func(context.Context, model.Principal, model.UserProfilePatch) (model.User, error) {
				calls++
				return model.User{}, nil
			})
			w := profileRequest(h, tc.body, tc.query, tc.media, false, "")
			if w.Code != tc.status || calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", w.Code, calls, w.Body.String())
			}
		})
	}
}

func TestPatchMeAuthenticationAndFailure(t *testing.T) {
	for _, origin := range []string{"", "https://other.example"} {
		h := profileHTTP(t, func(context.Context, model.Principal, model.UserProfilePatch) (model.User, error) {
			t.Fatal("rejected Cookie reached operation")
			return model.User{}, nil
		})
		w := profileRequest(h, `{"name":null}`, "", "application/json", true, origin)
		if w.Code != 403 {
			t.Fatalf("Cookie origin status=%d", w.Code)
		}
	}
	for _, tc := range []struct {
		code   string
		status int
	}{{"unauthenticated", 401}, {"write_outcome_unknown", 503}, {"payload_too_large", 413}} {
		h := profileHTTP(t, func(context.Context, model.Principal, model.UserProfilePatch) (model.User, error) {
			return model.User{}, &model.Fault{Code: tc.code, Message: "operation refused"}
		})
		w := profileRequest(h, `{"name":null}`, "", "application/json", false, "")
		if w.Code != tc.status || strings.Contains(w.Body.String(), "personalTeam") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	}
	h := profileHTTP(t, nil)
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/me", strings.NewReader(`{"name":null}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer dnapi_invalid")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 401 {
		t.Fatalf("unadmitted credential status %d", w.Code)
	}
}

func TestPatchMeInheritsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	h := profileHTTP(t, func(got context.Context, _ model.Principal, _ model.UserProfilePatch) (model.User, error) {
		cancel()
		<-got.Done()
		if !errors.Is(got.Err(), context.Canceled) {
			t.Fatal(got.Err())
		}
		return model.User{}, got.Err()
	})
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/me", strings.NewReader(`{"avatarUrl":""}`)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer valid")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Body.Len() != 0 {
		t.Fatalf("cancelled response %s", w.Body.String())
	}
}

func TestPatchMeSparseFieldsAndParentDeadline(t *testing.T) {
	for _, body := range []string{`{"name":null}`, `{"avatarUrl":""}`} {
		deadline := time.Now().Add(time.Second)
		ctx, cancel := context.WithDeadline(context.Background(), deadline)
		calls := 0
		h := profileHTTP(t, func(got context.Context, _ model.Principal, patch model.UserProfilePatch) (model.User, error) {
			calls++
			actual, ok := got.Deadline()
			if !ok || !actual.Equal(deadline) {
				t.Fatalf("deadline=%v", actual)
			}
			if body == `{"name":null}` {
				if !patch.Name.Present || patch.Name.Value != nil || patch.AvatarURL.Present {
					t.Fatalf("patch=%+v", patch)
				}
			} else {
				if patch.Name.Present || !patch.AvatarURL.Present || patch.AvatarURL.Value == nil || *patch.AvatarURL.Value != "" {
					t.Fatalf("patch=%+v", patch)
				}
			}
			return model.User{}, nil
		})
		req := httptest.NewRequest(http.MethodPatch, "/api/v1/me", strings.NewReader(body)).WithContext(ctx)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer valid")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		cancel()
		if calls != 1 || w.Code != 200 {
			t.Fatalf("calls=%d status=%d", calls, w.Code)
		}
	}
}

type failedProfileWriter struct {
	*httptest.ResponseRecorder
	writes int
	short  bool
}

func (w *failedProfileWriter) Write(data []byte) (int, error) {
	w.writes++
	n := len(data) / 2
	_, _ = w.ResponseRecorder.Write(data[:n])
	if w.short {
		return n, nil
	}
	return n, io.ErrClosedPipe
}

func profileResponseLogs(t *testing.T, logs *bytes.Buffer) []map[string]any {
	t.Helper()
	decoder := json.NewDecoder(logs)
	var entries []map[string]any
	for decoder.More() {
		var entry map[string]any
		if err := decoder.Decode(&entry); err != nil {
			t.Fatal(err)
		}
		if entry["phase"] == "response" {
			entries = append(entries, entry)
		}
	}
	return entries
}

func TestPatchMeResponseFailureDoesNotRepeatOperation(t *testing.T) {
	for _, short := range []bool{false, true} {
		t.Run(map[bool]string{false: "writer_error", true: "short_write"}[short], func(t *testing.T) {
			calls := 0
			var logs bytes.Buffer
			h := profileHTTPLogged(t, func(context.Context, model.Principal, model.UserProfilePatch) (model.User, error) {
				calls++
				return model.User{ID: "profile-user"}, nil
			}, slog.New(slog.NewJSONHandler(&logs, nil)))
			req := httptest.NewRequest(http.MethodPatch, "/api/v1/me", strings.NewReader(`{"name":null}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer valid")
			w := &failedProfileWriter{ResponseRecorder: httptest.NewRecorder(), short: short}
			h.ServeHTTP(w, req)
			if calls != 1 || w.writes != 1 || w.Code != 200 || strings.Contains(w.Body.String(), `"error"`) {
				t.Fatalf("operations=%d writes=%d status=%d body=%s", calls, w.writes, w.Code, w.Body.String())
			}
			entries := profileResponseLogs(t, &logs)
			if len(entries) != 1 || entries[0]["auth_error_code"] != "write_outcome_unknown" || entries[0]["write_outcome"] != "unknown" {
				t.Fatalf("response diagnostics=%v", entries)
			}
		})
	}
}

func TestPatchMeCommittedResponseCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := 0
	var logs bytes.Buffer
	h := profileHTTPLogged(t, func(context.Context, model.Principal, model.UserProfilePatch) (model.User, error) {
		calls++
		cancel()
		return model.User{}, nil
	}, slog.New(slog.NewJSONHandler(&logs, nil)))
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/me", strings.NewReader(`{"name":null}`)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer valid")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if calls != 1 || w.Body.Len() != 0 || w.Header().Get("Content-Type") != "" {
		t.Fatalf("operations=%d body=%s headers=%v", calls, w.Body.String(), w.Header())
	}
	entries := profileResponseLogs(t, &logs)
	if len(entries) != 1 || entries[0]["auth_error_code"] != "write_outcome_unknown" || entries[0]["write_outcome"] != "unknown" || entries[0]["cause"] != "canceled" {
		t.Fatalf("response diagnostics=%v", entries)
	}
}

func TestPatchMeTransactionCompletion(t *testing.T) {
	for _, tc := range []struct {
		name    string
		failure error
		status  int
		code    string
	}{
		{"unknown_network", fmt.Errorf("profile transaction: %w", &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: &net.OpError{Op: "read", Net: "tcp", Err: errors.New("private network detail")}}), 503, "write_outcome_unknown"},
		{"unknown_deadline", fmt.Errorf("profile transaction: %w", &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: context.DeadlineExceeded}), 503, "write_outcome_unknown"},
		{"cleanup_priority", errors.Join(&store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("private commit detail")}, &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: &model.Fault{Code: "forbidden", Message: "private refusal"}}), 500, "internal_error"},
		{"sql_failure", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &store.Error{Phase: "update", DatabaseFailure: true, Cause: &model.Fault{Code: "forbidden", Message: "private SQL refusal"}}}, 500, "internal_error"},
		{"commit_rejected", &store.TransactionError{Phase: "commit", Outcome: store.TransactionNotCommitted, CommitAttempted: true, Cause: errors.New("private commit rejection")}, 500, "internal_error"},
		{"rolled_back_refusal", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &model.Fault{Code: "unauthenticated", Message: "credential expired"}}, 401, "unauthenticated"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			var logs bytes.Buffer
			h := profileHTTPLogged(t, func(context.Context, model.Principal, model.UserProfilePatch) (model.User, error) {
				calls++
				return model.User{}, tc.failure
			}, slog.New(slog.NewJSONHandler(&logs, nil)))
			w := profileRequest(h, `{"name":null}`, "", "application/json", false, "")
			var response api.ErrorResponse
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if calls != 1 || w.Code != tc.status || response.Error.Code != tc.code || strings.Contains(logs.String(), "private") || strings.Contains(w.Body.String(), "private") {
				t.Fatalf("calls=%d status=%d body=%s logs=%s", calls, w.Code, w.Body.String(), logs.String())
			}
			if tc.code == "write_outcome_unknown" && (!strings.Contains(logs.String(), `"auth_error_code":"write_outcome_unknown"`) || !strings.Contains(logs.String(), `"phase":"commit"`)) {
				t.Fatalf("unknown commit diagnostics=%s", logs.String())
			}
		})
	}
}
