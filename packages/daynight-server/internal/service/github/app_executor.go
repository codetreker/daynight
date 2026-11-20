package github

import (
	"context"
	"errors"
	"log/slog"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
	"github.com/google/uuid"
)

// AppExecutionStore supplies App-aware work transactions and PR observations.
type AppExecutionStore interface {
	store.GitHubAppWorkWriter
	store.SnapshotReader
}

// AppClientSource lends one credential-version client until release is called.
type AppClientSource interface {
	Acquire(context.Context, string, int64) (*remote.Client, func(), error)
}

// AppExecutor admits current authorization before borrowing a client. Its caller
// owns the provider and retains it until every execution has drained.
type AppExecutor struct {
	db      AppExecutionStore
	clients AppClientSource
	log     *slog.Logger
}

func NewAppExecutor(db AppExecutionStore, clients AppClientSource, logger *slog.Logger) (*AppExecutor, error) {
	if db == nil || clients == nil {
		return nil, errors.New("github App executor requires work store and client provider")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &AppExecutor{db: db, clients: clients, log: logger}, nil
}

func (e *AppExecutor) Execute(ctx context.Context, project string) error {
	return e.ExecuteWithClaimContext(ctx, ctx, project)
}

func (e *AppExecutor) ExecuteWithClaimContext(ctx, claims context.Context, project string) error {
	if ctx == nil || claims == nil || project == "" {
		return errors.New("github App execution requires contexts and Project ID")
	}
	r := &run{project: project, snapshot: e.db, lease: store.GitHubLease{Token: uuid.NewString()}}
	r.log = e.log.With("component", "github_sync", "project_id", project, "sync_id", r.lease.Token)
	var identity store.GitHubAppWorkIdentity
	selected := false
	claimCtx, cancel := context.WithTimeout(claims, core.OperationTimeout)
	completion, err := e.db.WriteGitHubAppWork(claimCtx, project, nil, func(d store.GitHubAppWorkDAO) error {
		identity = d.Identity()
		conn, err := d.Connection(claimCtx)
		if err != nil {
			return err
		}
		now, err := d.ObservedAt(claimCtx)
		if err != nil {
			return err
		}
		pending, err := d.HasDuePending(claimCtx, now)
		if err != nil {
			return err
		}
		kind := core.WorkKind(conn, identity.AppID, now, pending)
		if kind == "" {
			return nil
		}
		r.connection, r.kind, r.lease.Generation = conn, kind, conn.Generation
		selected, err = d.Claim(claimCtx, store.GitHubClaim{AppID: identity.AppID, Generation: conn.Generation, Token: r.lease.Token, Kind: kind, Until: now.Add(core.LeaseDuration)})
		return err
	})
	cancel()
	if errors.Is(err, store.ErrGitHubAppWorkUnavailable) && completion.Outcome == store.TransactionNotCommitted {
		return nil
	}
	// Uncertain admission grants no permission to fetch; the claim may expire.
	if err := committed(completion, err); err != nil {
		return err
	}
	if !selected {
		return nil
	}
	r.appID = identity.AppID
	r.log = r.log.With("repository_id", *r.connection.RepositoryID, "installation_id", *r.connection.InstallationID, "app_resource_id", identity.AppResourceID, "app_id", identity.AppID, "credential_version", identity.CredentialVersion, "grant_id", identity.GrantID, "team_id", identity.TeamID, "ownership_version", identity.OwnershipVersion, "generation", r.lease.Generation, "trigger", r.kind)
	r.write = func(c context.Context, fn func(context.Context, store.GitHubWorkDAO) error) (store.Completion, error) {
		return e.db.WriteGitHubAppWork(c, project, &identity, func(d store.GitHubAppWorkDAO) error { return fn(c, d) })
	}
	acquireCtx, cancelAcquire := context.WithTimeout(ctx, core.OperationTimeout)
	client, release, err := e.clients.Acquire(acquireCtx, identity.AppResourceID, identity.CredentialVersion)
	cancelAcquire()
	if err != nil {
		return err
	}
	defer release()
	r.remote = client
	started := time.Now()
	r.log.InfoContext(ctx, "github sync started", "phase", "claim")
	err = r.execute(ctx)
	if err != nil {
		attrs := append([]any{"phase", "stop", "duration_ms", time.Since(started).Milliseconds()}, appErrorAttributes(err)...)
		r.log.WarnContext(ctx, "github sync stopped", attrs...)
	} else {
		r.log.InfoContext(ctx, "github sync completed", "phase", "finish", "duration_ms", time.Since(started).Milliseconds())
	}
	return err
}
