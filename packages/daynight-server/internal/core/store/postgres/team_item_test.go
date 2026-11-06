package postgres

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/teamitem"
	itemservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/teamitem"
	"github.com/google/uuid"
)

func itemPAT(t *testing.T, s *Store, user string) core.Authority {
	t.Helper()
	id := uuid.NewString()
	mustQueryExec(t, s, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'item test',clock_timestamp())`, id, user, deviceStoreHash(id))
	return core.Authority{Principal: model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: id}, Kind: "pat", ID: id}
}

func itemRead(t *testing.T, s *itemservice.Service, a core.Authority, in core.Input) core.Result {
	t.Helper()
	result, err := s.Read(t.Context(), a, in)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestTeamItemReadsExactFieldsAndTimestampChanges(t *testing.T) {
	s, actor, team := storeTeamFixture(t)
	a := itemPAT(t, s, actor.UserID)
	service := itemservice.New(s)
	profile := "名😀<\"\\\n"
	mustQueryExec(t, s, `UPDATE users SET name=$2,email=NULL,avatar_url='' WHERE id=$1`, actor.UserID, profile)
	target := core.Target{Kind: "member", TeamID: team.ID, UserID: actor.UserID}
	metadata := itemRead(t, service, a, core.Input{Target: target, Action: "inspect"}).Metadata
	if metadata.Member == nil || metadata.Member.UserID != actor.UserID || metadata.Fields[0].SizeBytes != int64(len(profile)) || !metadata.Fields[1].IsNull || metadata.Fields[2].IsNull || metadata.Fields[2].SizeBytes != 0 {
		t.Fatalf("member metadata: %#v", metadata)
	}
	var reconstructed []byte
	for offset := int64(0); offset < int64(len(profile)); {
		chunk := itemRead(t, service, a, core.Input{Target: target, Action: "chunk", Revision: metadata.Revision, Field: "profile.name", Offset: offset, MaxBytes: 3})
		reconstructed = append(reconstructed, chunk.Content...)
		offset += int64(len(chunk.Content))
		if chunk.EOF != (offset == int64(len(profile))) {
			t.Fatalf("wrong EOF at %d", offset)
		}
	}
	if !bytes.Equal(reconstructed, []byte(profile)) {
		t.Fatalf("changed profile bytes: %q", reconstructed)
	}
	for _, field := range []string{"profile.name", "profile.avatarUrl"} {
		offset := int64(len(profile))
		if field == "profile.avatarUrl" {
			offset = 0
		}
		last := itemRead(t, service, a, core.Input{Target: target, Action: "chunk", Revision: metadata.Revision, Field: field, Offset: offset, MaxBytes: 3})
		if !last.EOF || len(last.Content) != 0 {
			t.Fatalf("terminal chunk: %#v", last)
		}
	}
	for _, tc := range []struct {
		field  string
		offset int64
	}{{"profile.email", 0}, {"unknown", 0}, {"profile.name", int64(len(profile) + 1)}} {
		_, err := service.Read(t.Context(), a, core.Input{Target: target, Action: "chunk", Revision: metadata.Revision, Field: tc.field, Offset: tc.offset, MaxBytes: 3})
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "invalid_input" {
			t.Fatalf("invalid field %q offset %d: %v", tc.field, tc.offset, err)
		}
	}
	mustQueryExec(t, s, `UPDATE users SET name='new',updated_at=updated_at WHERE id=$1`, actor.UserID)
	result, err := service.Read(t.Context(), a, core.Input{Target: target, Action: "chunk", Revision: metadata.Revision, Field: "profile.name", MaxBytes: 3})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "version_conflict" || len(result.Content) != 0 || result.Metadata.Revision != "" {
		t.Fatalf("changed timestamp leaked content: %#v %v", result, err)
	}
	fresh := itemRead(t, service, a, core.Input{Target: target, Action: "inspect"})
	if fresh.Metadata.Revision == metadata.Revision {
		t.Fatal("same-time profile update retained revision")
	}
	teamTarget := core.Target{Kind: "team", TeamID: team.ID}
	tm := itemRead(t, service, a, core.Input{Target: teamTarget, Action: "inspect"}).Metadata
	if tm.Team == nil || tm.Team.Name != nil || tm.Fields[0].SizeBytes != int64(len("Ordinary")) {
		t.Fatalf("Team metadata: %#v", tm)
	}
	chunk := itemRead(t, service, a, core.Input{Target: teamTarget, Action: "chunk", Revision: tm.Revision, Field: "name", MaxBytes: 100})
	if string(chunk.Content) != "Ordinary" || !chunk.EOF {
		t.Fatalf("Team name: %#v", chunk)
	}
	var personal string
	if err := s.Pool.QueryRow(t.Context(), `SELECT id::text FROM teams WHERE personal_user_id=$1`, actor.UserID).Scan(&personal); err != nil {
		t.Fatal(err)
	}
	pm := itemRead(t, service, a, core.Input{Target: core.Target{Kind: "team", TeamID: personal}, Action: "inspect"}).Metadata
	if pm.Team.Kind != "personal" || !pm.Fields[0].IsNull {
		t.Fatalf("personal Team: %#v", pm)
	}
}

func TestProjectItemPreservesTeamScopeAndDeletion(t *testing.T) {
	s, actor, team := storeTeamFixture(t)
	a := itemPAT(t, s, actor.UserID)
	_, outsider, _ := testAuthRecords(t, s)
	other := itemPAT(t, s, outsider.UserID)
	id := uuid.NewString()
	name := strings.Repeat("界", 10000)
	mustQueryExec(t, s, `INSERT INTO projects(id,name,repo_url) VALUES($1,$2,'host:repo')`, id, name)
	mustQueryExec(t, s, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, id, team.ID)
	mustQueryExec(t, s, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, id, outsider.UserID)
	service := itemservice.New(s)
	target := core.Target{Kind: "project", TeamID: team.ID, ProjectID: id}
	metadata := itemRead(t, service, a, core.Input{Target: target, Action: "inspect"}).Metadata
	if metadata.Project == nil || metadata.Project.Name != "" || metadata.Project.RepoURL != "" || metadata.Fields[0].SizeBytes != int64(len(name)) {
		t.Fatalf("Project metadata: %#v", metadata)
	}
	chunk := itemRead(t, service, a, core.Input{Target: target, Action: "chunk", Revision: metadata.Revision, Field: "name", Offset: int64(len(name) - 7), MaxBytes: 20})
	if !bytes.Equal(chunk.Content, []byte(name)[len(name)-7:]) || !chunk.EOF {
		t.Fatalf("late Project chunk: %#v", chunk)
	}
	repo := itemRead(t, service, a, core.Input{Target: target, Action: "chunk", Revision: metadata.Revision, Field: "repoUrl", MaxBytes: 20})
	if string(repo.Content) != "host:repo" {
		t.Fatalf("repository bytes: %q", repo.Content)
	}
	if _, err := service.Read(t.Context(), other, core.Input{Target: target, Action: "inspect"}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("direct grant read Team directory: %v", err)
	}
	mustQueryExec(t, s, `UPDATE projects SET deleted_at=clock_timestamp() WHERE id=$1`, id)
	if _, err := service.Read(t.Context(), a, core.Input{Target: target, Action: "inspect"}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deleted Project read: %v", err)
	}
}

type itemReadThen struct {
	*Store
	after func()
}

func (s itemReadThen) ReadTeamItem(ctx context.Context, fn func(store.TeamItemReader) error) error {
	if err := s.Store.ReadTeamItem(ctx, fn); err != nil {
		return err
	}
	s.after()
	return nil
}

func TestTeamItemFreshAuthorityRejectsChangesAfterContentRead(t *testing.T) {
	for _, change := range []string{"revoke", "expire", "leave", "remove_target", "delete_project", "transfer_project"} {
		t.Run(change, func(t *testing.T) {
			s, actor, team := storeTeamFixture(t)
			a := itemPAT(t, s, actor.UserID)
			target := core.Target{Kind: "team", TeamID: team.ID}
			if change == "remove_target" {
				_, targetUser, _ := testAuthRecords(t, s)
				mustQueryExec(t, s, `INSERT INTO team_members(team_id,user_id,role)VALUES($1,$2,'member')`, team.ID, targetUser.UserID)
				target.Kind = "member"
				target.UserID = targetUser.UserID
			}
			if change == "delete_project" || change == "transfer_project" {
				target.Kind = "project"
				target.ProjectID = uuid.NewString()
				mustQueryExec(t, s, `INSERT INTO projects(id,name,repo_url)VALUES($1,'Project','repo')`, target.ProjectID)
				mustQueryExec(t, s, `INSERT INTO project_ownership(project_id,team_id)VALUES($1,$2)`, target.ProjectID, team.ID)
			}
			wrapped := itemReadThen{Store: s, after: func() {
				switch change {
				case "revoke":
					mustQueryExec(t, s, `DELETE FROM personal_access_tokens WHERE id=$1`, a.ID)
				case "expire":
					mustQueryExec(t, s, `UPDATE personal_access_tokens SET created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, a.ID)
				case "leave":
					mustQueryExec(t, s, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, team.ID, actor.UserID)
				case "remove_target":
					mustQueryExec(t, s, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, team.ID, target.UserID)
				case "delete_project":
					mustQueryExec(t, s, `UPDATE projects SET deleted_at=clock_timestamp() WHERE id=$1`, target.ProjectID)
				case "transfer_project":
					mustQueryExec(t, s, `UPDATE project_ownership SET team_id=$2,version=version+1 WHERE project_id=$1`, target.ProjectID, uuid.NewString())
				}
			}}
			result, err := itemservice.New(wrapped).Read(t.Context(), a, core.Input{Target: target, Action: "inspect"})
			if err == nil || result.Metadata.Revision != "" || len(result.Content) != 0 {
				t.Fatalf("authority change leaked result: %#v %v", result, err)
			}
		})
	}
}

func TestTeamItemOAuthAuthorityChecksGrantScopeAndExpiry(t *testing.T) {
	s, actor, team := storeTeamFixture(t)
	grant, access := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, s, `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at)VALUES($1,$2,'client','{}','https://example.test/mcp','daynight:mcp',clock_timestamp(),clock_timestamp()+interval '1 hour')`, grant, actor.UserID)
	mustQueryExec(t, s, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at)VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '10 minutes')`, access, grant, actor.UserID, deviceStoreHash(access))
	a := core.Authority{Principal: model.Principal{Kind: model.OAuthCredential, CredentialID: access, UserID: actor.UserID}, Kind: "oauth", ID: grant, Resource: "https://example.test/mcp", Scope: "daynight:mcp"}
	target := core.Target{Kind: "team", TeamID: team.ID}
	service := itemservice.New(s)
	itemRead(t, service, a, core.Input{Target: target, Action: "inspect"})
	for _, tc := range []struct {
		name   string
		mutate func(*core.Authority)
	}{
		{"resource", func(a *core.Authority) { a.Resource = "https://other.test/mcp" }},
		{"scope", func(a *core.Authority) { a.Scope = "other" }},
		{"grant", func(a *core.Authority) { a.ID = uuid.NewString() }},
		{"access", func(a *core.Authority) { a.Principal.CredentialID = uuid.NewString() }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := a
			tc.mutate(&bad)
			if _, err := service.Read(t.Context(), bad, core.Input{Target: target, Action: "inspect"}); err == nil {
				t.Fatal("invalid OAuth authority accepted")
			}
		})
	}
	mustQueryExec(t, s, `UPDATE oauth_grants SET revoked_at=clock_timestamp() WHERE id=$1`, grant)
	if _, err := service.Read(t.Context(), a, core.Input{Target: target, Action: "inspect"}); err == nil {
		t.Fatal("revoked grant accepted")
	}
}

func waitItemLock(t *testing.T, s *Store, ctx context.Context, pid uint32, result <-chan error) {
	t.Helper()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		var waiting bool
		if err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		select {
		case err := <-result:
			t.Fatalf("reader finished before lock wait: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-tick.C:
		}
	}
}

func TestTeamItemAuthorityRechecksAfterLockWait(t *testing.T) {
	for _, change := range []string{"revoke", "expire", "leave", "remove_target", "grant_revoke", "grant_expire", "transfer_project", "delete_project"} {
		t.Run(change, func(t *testing.T) {
			s, actor, team := storeTeamFixture(t)
			a := itemPAT(t, s, actor.UserID)
			target := core.Target{Kind: "team", TeamID: team.ID}
			if change == "remove_target" {
				_, user, _ := testAuthRecords(t, s)
				mustQueryExec(t, s, `INSERT INTO team_members(team_id,user_id,role)VALUES($1,$2,'member')`, team.ID, user.UserID)
				target.Kind = "member"
				target.UserID = user.UserID
			}
			if strings.HasPrefix(change, "grant_") {
				grant, access := uuid.NewString(), uuid.NewString()
				mustQueryExec(t, s, `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at)VALUES($1,$2,'client','{}','https://example.test/mcp','daynight:mcp',clock_timestamp()-interval '2 hours',clock_timestamp()+interval '1 hour')`, grant, actor.UserID)
				mustQueryExec(t, s, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at)VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '10 minutes')`, access, grant, actor.UserID, deviceStoreHash(access))
				a = core.Authority{Principal: model.Principal{Kind: model.OAuthCredential, CredentialID: access, UserID: actor.UserID}, Kind: "oauth", ID: grant, Resource: "https://example.test/mcp", Scope: "daynight:mcp"}
			}
			if strings.HasSuffix(change, "project") {
				target.Kind = "project"
				target.ProjectID = uuid.NewString()
				mustQueryExec(t, s, `INSERT INTO projects(id,name,repo_url)VALUES($1,'Project','repo')`, target.ProjectID)
				mustQueryExec(t, s, `INSERT INTO project_ownership(project_id,team_id)VALUES($1,$2)`, target.ProjectID, team.ID)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			blocker, err := s.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer blocker.Rollback(context.Background())
			lockQuery, lockID := `SELECT id FROM teams WHERE id=$1 FOR UPDATE`, team.ID
			if target.Kind == "project" {
				lockQuery, lockID = `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, target.ProjectID
			}
			if _, err = blocker.Exec(ctx, lockQuery, lockID); err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() {
				value, err := itemservice.New(s).Read(ctx, a, core.Input{Target: target, Action: "inspect"})
				if value.Metadata.Revision != "" || len(value.Content) > 0 {
					err = errors.New("authorization wait leaked item data")
				}
				result <- err
			}()
			waitItemLock(t, s, ctx, blocker.Conn().PgConn().PID(), result)
			var sql string
			var args []any
			switch change {
			case "revoke":
				sql = `DELETE FROM personal_access_tokens WHERE id=$1`
				args = []any{a.ID}
			case "expire":
				sql = `UPDATE personal_access_tokens SET created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`
				args = []any{a.ID}
			case "leave":
				sql = `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`
				args = []any{team.ID, actor.UserID}
			case "remove_target":
				sql = `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`
				args = []any{team.ID, target.UserID}
			case "grant_revoke":
				sql = `UPDATE oauth_grants SET revoked_at=clock_timestamp() WHERE id=$1`
				args = []any{a.ID}
			case "grant_expire":
				sql = `UPDATE oauth_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`
				args = []any{a.ID}
			case "transfer_project":
				sql = `UPDATE project_ownership SET team_id=$2,version=version+1 WHERE project_id=$1`
				args = []any{target.ProjectID, uuid.NewString()}
			case "delete_project":
				sql = `UPDATE projects SET deleted_at=clock_timestamp() WHERE id=$1`
				args = []any{target.ProjectID}
			}
			if _, err = blocker.Exec(ctx, sql, args...); err != nil {
				t.Fatal(err)
			}
			if err = blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-result:
				if err == nil || err.Error() == "authorization wait leaked item data" {
					t.Fatalf("wait result: %v", err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
}

func TestTeamItemCancellationReleasesAuthorityWait(t *testing.T) {
	s, actor, team := storeTeamFixture(t)
	a := itemPAT(t, s, actor.UserID)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	blocker, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err = blocker.Exec(ctx, `SELECT id FROM teams WHERE id=$1 FOR UPDATE`, team.ID); err != nil {
		t.Fatal(err)
	}
	request, cancelRequest := context.WithCancel(ctx)
	result := make(chan error, 1)
	go func() {
		value, err := itemservice.New(s).Read(request, a, core.Input{Target: core.Target{Kind: "team", TeamID: team.ID}, Action: "inspect"})
		if value.Metadata.Revision != "" {
			err = errors.New("canceled read leaked metadata")
		}
		result <- err
	}()
	waitItemLock(t, s, ctx, blocker.Conn().PgConn().PID(), result)
	cancelRequest()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel cause lost: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// A discarded pgx connection is removed from pool accounting asynchronously.
	// Observe its actual release rather than equating callback return with removal.
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for s.Pool.Stat().AcquiredConns() != 1 {
		select {
		case <-ctx.Done():
			t.Fatalf("canceled authority check retained connections: %d", s.Pool.Stat().AcquiredConns())
		case <-tick.C:
		}
	}
}
