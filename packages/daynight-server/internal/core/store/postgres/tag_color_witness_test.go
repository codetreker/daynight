package postgres

import (
	"context"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	tagservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
	"github.com/jackc/pgx/v5/pgxpool"
)

type heldColorProjectWrite struct {
	*Store
	ready   chan uint32
	release chan struct{}
}

func (s *heldColorProjectWrite) WriteProject(ctx context.Context, projectID string, operation func(ProjectWriteScope) error) (Completion, error) {
	return s.Store.WriteProject(ctx, projectID, func(scope ProjectWriteScope) error {
		var pid uint32
		if err := scope.(*ProjectTx).tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
			return err
		}
		select {
		case s.ready <- pid:
		case <-ctx.Done():
			return ctx.Err()
		}
		select {
		case <-s.release:
			return operation(scope)
		case <-ctx.Done():
			return ctx.Err()
		}
	})
}

func TestTagColorServicePostgres(t *testing.T) {
	s, principal, outsider, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	service := tagservice.New(s)
	color := "#ab12cd"
	created, err := service.Create(ctx, principal, project.ID, "Before", &color)
	if err != nil || created.Outcome != TransactionCommitted || created.Item.Tag.Color != "#AB12CD" {
		t.Fatalf("create: %+v %v", created, err)
	}
	id := created.TagID
	// This bounded set exercises the real set-based touch for both resource types.
	mustQueryExec(t, s, `INSERT INTO tasks(id,project_id,title,type) SELECT gen_random_uuid(),$1,'tagged',CASE WHEN n%2=0 THEN 'goal' ELSE 'task' END FROM generate_series(1,512) n`, project.ID)
	mustQueryExec(t, s, `INSERT INTO task_tags(project_id,task_id,tag_id) SELECT project_id,id,$2 FROM tasks WHERE project_id=$1`, project.ID, id)
	untagged := queryTask(t, s, project.ID, 777, model.TaskTodo)
	type state struct {
		Name, Color, Epoch                      string
		Version, Count, Versions, Bad, Untagged int64
	}
	read := func() state {
		t.Helper()
		var result state
		if err := s.Pool.QueryRow(ctx, `SELECT t.name,t.color,p.tag_catalog_epoch::text,t.version,(SELECT count(*) FROM task_tags WHERE project_id=$1 AND tag_id=$2),(SELECT sum(version) FROM tasks WHERE project_id=$1),(SELECT count(*) FROM tasks a JOIN task_tags tt ON tt.project_id=a.project_id AND tt.task_id=a.id WHERE tt.project_id=$1 AND tt.tag_id=$2 AND a.version<>t.version),(SELECT version FROM tasks WHERE project_id=$1 AND id=$3) FROM project_tags t JOIN projects p ON p.id=t.project_id WHERE t.project_id=$1 AND t.id=$2`, project.ID, id, untagged.ID).Scan(&result.Name, &result.Color, &result.Epoch, &result.Version, &result.Count, &result.Versions, &result.Bad, &result.Untagged); err != nil {
			t.Fatal(err)
		}
		return result
	}
	initial := read()
	if initial.Count != 512 || initial.Bad != 0 || initial.Untagged != untagged.Version {
		t.Fatalf("initial fixture: %+v", initial)
	}
	name, nextColor := "After", "#00ff55"
	// A real SQL failure at either dependent write must roll back the tag update.
	for _, target := range []string{"tasks", "projects"} {
		mustQueryExec(t, s, `CREATE FUNCTION reject_color_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected color write failure'; END $$`)
		mustQueryExec(t, s, `CREATE TRIGGER reject_color_touch BEFORE UPDATE ON `+target+` FOR EACH ROW EXECUTE FUNCTION reject_color_touch()`)
		result, err := service.Update(ctx, principal, project.ID, id, 1, &name, &nextColor)
		if err == nil || result.Outcome != TransactionNotCommitted || read() != initial {
			t.Fatalf("%s failure did not roll back: %+v %v state=%+v", target, result, err, read())
		}
		mustQueryExec(t, s, `DROP TRIGGER reject_color_touch ON `+target)
		mustQueryExec(t, s, `DROP FUNCTION reject_color_touch()`)
	}
	if _, err := service.Update(ctx, outsider, project.ID, id, 1, &name, &nextColor); err == nil || read() != initial {
		t.Fatalf("unauthorized write: %v", err)
	}
	other, err := s.CreatePrivateProject(ctx, principal, queryID(998), "Other", "https://example.com/other")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Update(ctx, principal, other.ID, id, 1, &name, &nextColor); err == nil || read() != initial {
		t.Fatalf("cross-project write: %v", err)
	}
	bad := "#XYZ123"
	if _, err := service.Update(ctx, principal, project.ID, id, 1, nil, &bad); err == nil || read() != initial {
		t.Fatalf("invalid color write: %v", err)
	}
	// Read epoch first, commit a write, then resolve in that same real snapshot.
	if err := s.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		epoch, err := scope.TagDAO().TagCatalogEpoch(ctx, project.ID)
		if err != nil {
			return err
		}
		updated, err := service.Update(ctx, principal, project.ID, id, 1, &name, &nextColor)
		if err != nil || updated.Item.Tag.Version != 2 || updated.Item.Tag.Name != name || updated.Item.Tag.Color != "#00FF55" {
			t.Fatalf("atomic update: %+v %v", updated, err)
		}
		items, err := scope.TagDAO().ResolveTags(ctx, project.ID, []string{id})
		if err != nil || epoch != initial.Epoch || len(items) != 1 || items[0].Version != 1 || items[0].Color != initial.Color {
			t.Fatalf("snapshot mixed revisions: %q %+v %v", epoch, items, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	updated := read()
	if updated.Version != 2 || updated.Epoch == initial.Epoch || updated.Count != 512 || updated.Versions != initial.Versions+512 || updated.Bad != 0 || updated.Untagged != initial.Untagged {
		t.Fatalf("touch/epoch: before=%+v after=%+v", initial, updated)
	}
	missing := queryID(999)
	page, err := service.ResolveColors(ctx, principal, project.ID, []string{id, missing, id}, nil)
	if err != nil || page.CatalogEpoch != updated.Epoch || len(page.Items) != 2 || !page.Items[0].Found || page.Items[0].Version != 2 || page.Items[0].Color != "#00FF55" || page.Items[1].Found || page.Items[1].ID != missing {
		t.Fatalf("colors: %+v %v", page, err)
	}
	if _, err := service.ResolveColors(ctx, principal, project.ID, []string{id}, &initial.Epoch); err == nil {
		t.Fatal("stale epoch accepted")
	} else {
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "catalog_changed" {
			t.Fatalf("stale epoch error: %v", err)
		}
	}
	if _, err := service.ResolveColors(ctx, principal, project.ID, []string{"invalid"}, nil); err == nil {
		t.Fatal("invalid id accepted")
	}
	if _, err := service.ResolveColors(ctx, outsider, project.ID, []string{id}, nil); err == nil {
		t.Fatal("unauthorized read accepted")
	}
	if result, err := service.Update(ctx, principal, project.ID, id, 2, &name, &nextColor); err != nil || result.Item.Tag.Version != 2 || read() != updated {
		t.Fatalf("no-op: %+v %v", result, err)
	}
	if _, err := service.Update(ctx, principal, project.ID, id, 1, &name, &nextColor); err == nil || read() != updated {
		t.Fatalf("stale no-op: %v", err)
	}
	// Hold the first real Project transaction until PostgreSQL shows the second
	// writer waiting on it. Both decisions carry the same exact version.
	type attempt struct {
		result tagservice.WriteResult
		err    error
	}
	held := &heldColorProjectWrite{Store: s, ready: make(chan uint32, 1), release: make(chan struct{})}
	released := false
	defer func() {
		if !released {
			close(held.release)
		}
	}()
	results := make(chan attempt, 2)
	go func() {
		value := "#111111"
		result, err := tagservice.New(held).Update(ctx, principal, project.ID, id, 2, nil, &value)
		results <- attempt{result, err}
	}()
	var blocker uint32
	select {
	case blocker = <-held.ready:
	case <-ctx.Done():
		t.Fatal("first writer did not acquire the Project lock")
	}
	go func() {
		value := "#222222"
		result, err := service.Update(ctx, principal, project.ID, id, 2, nil, &value)
		results <- attempt{result, err}
	}()
	if err := waitForTaskStoreLock(ctx, s, blocker); err != nil {
		t.Fatal(err)
	}
	close(held.release)
	released = true
	wins, conflicts := 0, 0
	for range 2 {
		attempt := <-results
		if attempt.err == nil && attempt.result.Outcome == TransactionCommitted {
			wins++
			continue
		}
		var fault *model.Fault
		if errors.As(attempt.err, &fault) && fault.Code == "version_conflict" {
			conflicts++
			continue
		}
		t.Fatalf("unexpected competitor: %+v %v", attempt.result, attempt.err)
	}
	competed := read()
	if wins != 1 || conflicts != 1 || competed.Version != 3 || competed.Versions != updated.Versions+512 || competed.Bad != 0 || competed.Untagged != initial.Untagged || competed.Epoch == updated.Epoch || competed.Color != "#111111" {
		t.Fatalf("competition wins=%d conflicts=%d state=%+v", wins, conflicts, competed)
	}
	renamed, err := service.Rename(ctx, principal, project.ID, id, 3, "Legacy rename")
	if err != nil || renamed.Item.Tag.Version != 4 || renamed.Item.Tag.Color != competed.Color {
		t.Fatalf("legacy rename: %+v %v", renamed, err)
	}
	if _, err := service.Delete(ctx, principal, project.ID, id, 4, true); err != nil {
		t.Fatal(err)
	}
	recreated, err := service.Create(ctx, principal, project.ID, "Legacy rename", nil)
	if err != nil || recreated.TagID == id || recreated.Item.Tag.Color != "#9AA3B2" {
		t.Fatalf("recreate: %+v %v", recreated, err)
	}
	page, err = service.ResolveColors(ctx, principal, project.ID, []string{id, recreated.TagID}, nil)
	if err != nil || len(page.Items) != 2 || page.Items[0].Found || !page.Items[1].Found || page.Items[1].Color != "#9AA3B2" {
		t.Fatalf("recreated colors: %+v %v", page, err)
	}
}

func TestTagColorLostCommitReceipt(t *testing.T) {
	s, principal, _, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	created, err := tagservice.New(s).Create(ctx, principal, project.ID, "Before", nil)
	if err != nil {
		t.Fatal(err)
	}
	task := queryTask(t, s, project.ID, 777, model.TaskTodo)
	mustQueryExec(t, s, `INSERT INTO task_tags(project_id,task_id,tag_id) VALUES ($1,$2,$3)`, project.ID, task.ID, created.TagID)
	var before string
	if err := s.Pool.QueryRow(ctx, `SELECT tag_catalog_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	var armed, lost atomic.Bool
	config := s.Pool.Config().Copy()
	config.ConnConfig.TLSConfig = nil
	config.ConnConfig.Fallbacks = nil
	config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &lostGrantCommitConn{Conn: conn, armed: &armed, lost: &lost}, nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	armed.Store(true)
	name, color := "After", "#ABCDEF"
	result, err := tagservice.New(&Store{Pool: pool}).Update(ctx, principal, project.ID, created.TagID, 1, &name, &color)
	var failure *TransactionError
	if !lost.Load() || result.Outcome != TransactionUnknown || result.Phase != "commit" || !errors.As(err, &failure) || !failure.CommitAttempted || result.Item.Tag.ID != "" {
		t.Fatalf("lost receipt: lost=%v result=%+v error=%v", lost.Load(), result, err)
	}
	var gotName, gotColor, epoch string
	var version, taskVersion int64
	if err := s.Pool.QueryRow(ctx, `SELECT name,color,version,(SELECT version FROM tasks WHERE id=$3),(SELECT tag_catalog_epoch::text FROM projects WHERE id=$1) FROM project_tags WHERE project_id=$1 AND id=$2`, project.ID, created.TagID, task.ID).Scan(&gotName, &gotColor, &version, &taskVersion, &epoch); err != nil {
		t.Fatal(err)
	}
	if gotName != name || gotColor != color || version != 2 || taskVersion != task.Version+1 || epoch == before {
		t.Fatalf("actual committed facts: name=%q color=%q version=%d taskVersion=%d epoch=%q", gotName, gotColor, version, taskVersion, epoch)
	}
}
