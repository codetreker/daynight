package worker

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
)

const readOnlyTransportOrigin = "http://127.0.0.1:8787"
const readOnlyOwnerPAT = "dnpat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const readOnlyOtherPAT = "dnpat_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"
const readOnlyRejectedPAT = "dnpat_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA"
const readOnlyOwnerSession = "dnst_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA"

type readOnlyTransportFixture struct {
	server *httptest.Server
	token  string
	cookie *http.Cookie
	worker string
	owner  model.Principal
	routes *ReadOnlyRoutes
}

type controlledReadOnlyTransport struct {
	readOnlyTransportFixture
	otherToken    string
	unknownWorker string
}

func newReadOnlyTransportFixture(t *testing.T, configure ...func(*ReadOnlyRoutes)) *controlledReadOnlyTransport {
	t.Helper()
	const worker = "30000000-0000-4000-8000-000000000001"
	const unknownWorker = "30000000-0000-4000-8000-000000000002"
	owner := model.Principal{Kind: model.SessionCredential, UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "20000000-0000-4000-8000-000000000001"}
	ownerPAT := model.Principal{Kind: model.PATCredential, UserID: owner.UserID, CredentialID: "20000000-0000-4000-8000-000000000002"}
	otherPAT := model.Principal{Kind: model.PATCredential, UserID: "10000000-0000-4000-8000-000000000002", CredentialID: "20000000-0000-4000-8000-000000000003"}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		switch {
		case kind == model.PATCredential && token == readOnlyOwnerPAT:
			return ownerPAT, ctx.Err()
		case kind == model.PATCredential && token == readOnlyOtherPAT:
			return otherPAT, ctx.Err()
		case kind == model.SessionCredential && token == readOnlyOwnerSession:
			return owner, ctx.Err()
		case kind == model.PATCredential && token == readOnlyRejectedPAT:
			return model.Principal{}, authhttp.Failure()
		default:
			t.Errorf("unexpected read-only credential: kind=%q", kind)
			return model.Principal{}, authhttp.Failure()
		}
	}, authconfig.AuthSettings{PublicOrigin: readOnlyTransportOrigin, AllowHTTPTestOrigin: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	broker := ro.New(func(ctx context.Context, principal model.Principal, target string) error {
		switch {
		case (principal == ownerPAT || principal == owner) && target == worker:
			return ctx.Err()
		case principal == ownerPAT && target == unknownWorker, principal == otherPAT && target == worker:
			return &model.Fault{Code: "not_found", Message: "Worker was not found."}
		default:
			t.Errorf("unexpected read-only Worker authority check: principal=%+v target=%q", principal, target)
			return &model.Fault{Code: "not_found", Message: "Worker was not found."}
		}
	})
	routes := NewReadOnlyRoutes(broker, &authhttp.Authentication{RequestAuthentication: auth}, logger)
	for _, apply := range configure {
		apply(routes)
	}
	mux := http.NewServeMux()
	routes.RegisterRoutes(mux)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := routes.Shutdown(ctx); err != nil {
			t.Errorf("read-only transport shutdown: %v", err)
		}
	})
	return &controlledReadOnlyTransport{
		readOnlyTransportFixture: readOnlyTransportFixture{
			server: server, owner: owner, worker: worker, token: readOnlyOwnerPAT, routes: routes,
			cookie: &http.Cookie{Name: auth.SessionCookieName(), Value: readOnlyOwnerSession},
		},
		otherToken: readOnlyOtherPAT, unknownWorker: unknownWorker,
	}
}
