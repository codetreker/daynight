package postgres

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	tasktext "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/text"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	tagservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestTagScopesShareSnapshotAndProjectTransaction(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	project := queryProject(t, s, 1)
	task := queryTask(t, s, project.ID, 11, model.TaskTodo)
	tagID := queryID(21)
	var initialEpoch string
	if err := s.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		var err error
		initialEpoch, err = scope.TagDAO().TagCatalogEpoch(ctx, project.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	abort := errors.New("abort tag transaction")
	completion, err := s.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
		now, err := scope.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		if _, err := scope.TagDAO().InsertTag(ctx, model.Tag{ID: tagID, Name: "Before", NameKey: "before", Color: "#9AA3B2", CreatedAt: now}); err != nil {
			return err
		}
		if err := scope.TaskTagDAO().ReplaceTaskTags(ctx, task.ID, []string{tagID}); err != nil {
			return err
		}
		if err := scope.ProjectDAO().RotateTagCatalogEpoch(ctx); err != nil {
			return err
		}
		return abort
	})
	if !errors.Is(err, abort) || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("rollback: %#v %v", completion, err)
	}
	var count int
	var epoch string
	if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM task_tags WHERE project_id=$1)+(SELECT count(*) FROM project_tags WHERE project_id=$1),tag_catalog_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&count, &epoch); err != nil || count != 0 || epoch != initialEpoch {
		t.Fatalf("rollback readback: %d %s %v", count, epoch, err)
	}
	completion, err = s.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
		now, err := scope.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		if _, err := scope.TagDAO().InsertTag(ctx, model.Tag{ID: tagID, Name: "Before", NameKey: "before", Color: "#9AA3B2", CreatedAt: now}); err != nil {
			return err
		}
		if err := scope.TaskTagDAO().ReplaceTaskTags(ctx, task.ID, []string{tagID}); err != nil {
			return err
		}
		return scope.ProjectDAO().RotateTagCatalogEpoch(ctx)
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("commit: %#v %v", completion, err)
	}
	if err := s.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		original, err := scope.TagDAO().Tag(ctx, project.ID, tagID)
		if err != nil {
			return err
		}
		epoch, err := scope.TagDAO().TagCatalogEpoch(ctx, project.ID)
		if err != nil {
			return err
		}
		if epoch == initialEpoch {
			t.Fatal("catalog epoch did not rotate")
		}
		completion, err := s.WriteProject(ctx, project.ID, func(write ProjectWriteScope) error {
			now, err := write.TaskDAO().ObservedAt(ctx)
			if err != nil {
				return err
			}
			if _, err := write.TagDAO().UpdateTag(ctx, tagID, original.Version, "After", "after", "#9AA3B2", now); err != nil {
				return err
			}
			return write.ProjectDAO().RotateTagCatalogEpoch(ctx)
		})
		if err != nil || completion.Outcome != TransactionCommitted {
			t.Fatalf("concurrent commit: %#v %v", completion, err)
		}
		again, err := scope.TagDAO().Tag(ctx, project.ID, tagID)
		if err != nil {
			return err
		}
		againEpoch, err := scope.TagDAO().TagCatalogEpoch(ctx, project.ID)
		if err != nil {
			return err
		}
		if again.Name != "Before" || againEpoch != epoch {
			t.Fatalf("snapshot changed: %#v %s", again, againEpoch)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		item, err := scope.TagDAO().Tag(ctx, project.ID, tagID)
		if err != nil {
			return err
		}
		if item.Name != "After" || item.Version != 2 {
			t.Fatalf("committed value: %#v", item)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTagSnapshotQueryCancellation(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	ctx, finish := context.WithTimeout(context.Background(), 10*time.Second)
	defer finish()
	blocker, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if _, err := blocker.Exec(ctx, `LOCK TABLE project_tags IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	waiting, cancel := context.WithCancel(ctx)
	result := make(chan error, 1)
	go func() {
		result <- s.ReadSnapshot(waiting, func(scope SnapshotScope) error {
			_, err := scope.TagDAO().Tags(waiting, project.ID, TagQuery{Limit: 10})
			return err
		})
	}()
	waitForQueryLock(t, s, "SELECT id::text, project_id::text, name, name_key")
	cancel()
	if err := receiveQueryResult(t, ctx, result); !errors.Is(err, context.Canceled) {
		t.Fatalf("query cancellation cause: %v", err)
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	assertMigrationPoolReusable(t, s.Pool)
}

func TestTagDeleteAndAttachSerialize(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	task := queryTask(t, s, project.ID, 11, model.TaskTodo)
	tagID := queryID(21)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := writeProjectForTest(s, ctx, project.ID, func(scope ProjectWriteScope) error {
		now, err := scope.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		_, err = scope.TagDAO().InsertTag(ctx, model.Tag{ID: tagID, Name: "tag", NameKey: "tag", Color: "#9AA3B2", CreatedAt: now})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	if err := writeProjectForTest(s, ctx, project.ID, func(scope ProjectWriteScope) error {
		go func() {
			result <- writeProjectForTest(s, ctx, project.ID, func(waiter ProjectWriteScope) error {
				items, err := waiter.TagDAO().ResolveTags(ctx, []string{tagID})
				if err != nil {
					return err
				}
				if len(items) != 0 {
					return errors.New("waiter observed deleted tag")
				}
				return nil
			})
		}()
		waitForQueryLock(t, s, "SELECT id::text FROM projects WHERE")
		if err := scope.TaskTagDAO().ReplaceTaskTags(ctx, task.ID, []string{tagID}); err != nil {
			return err
		}
		if err := scope.TaskTagDAO().ClearTagAssociations(ctx, tagID); err != nil {
			return err
		}
		return scope.TagDAO().DeleteTag(ctx, tagID, 1)
	}); err != nil {
		t.Fatal(err)
	}
	if err := receiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM task_tags WHERE project_id=$1 AND tag_id=$2`, project.ID, tagID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("remaining associations: %d %v", count, err)
	}
}

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
	parallelRootDatabaseTest(t)
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
	parallelRootDatabaseTest(t)
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

func tagWitnessDelete(ctx context.Context, scope ProjectWriteScope, id string) error {
	now, err := scope.TaskDAO().ObservedAt(ctx)
	if err != nil {
		return err
	}
	if _, err = scope.TaskTagDAO().TouchTaggedTasks(ctx, id, now); err != nil {
		return err
	}
	if err = scope.TaskTagDAO().ClearTagAssociations(ctx, id); err != nil {
		return err
	}
	if err = scope.TagDAO().DeleteTag(ctx, id, 1); err != nil {
		return err
	}
	return scope.ProjectDAO().RotateTagCatalogEpoch(ctx)
}

func TestTaskTagAdmissionRollbackAndRenameReadback(t *testing.T) {
	parallelRootDatabaseTest(t)
	s, principal, _, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	item := queryTask(t, s, project.ID, 11, model.TaskTodo)
	tasks := taskservice.NewTasks(s)
	description := strings.Repeat("&", tasktext.MaxDescriptionBytes)
	current, err := tasks.Update(ctx, principal, project.ID, item.ID, taskcore.UpdateTask{Version: item.Version, Description: &description})
	if err != nil {
		t.Fatalf("legal description update: %v", err)
	}
	mustQueryExec(t, s, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at)
		SELECT gen_random_uuid(),$1,format('tag-%s',n),format('tag-%s',n),statement_timestamp(),statement_timestamp() FROM generate_series(1,400) n`, project.ID)
	rows, err := s.Pool.Query(ctx, `SELECT id::text,name FROM project_tags WHERE project_id=$1 ORDER BY id`, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	var refs []model.TagReference
	for rows.Next() {
		var ref model.TagReference
		if err := rows.Scan(&ref.ID, &ref.Name); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		ids = append(ids, ref.ID)
		refs = append(refs, ref)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatal(err)
	}
	rows.Close()
	reserved := current
	reserved.Version = math.MaxInt64
	reserved.UpdatedAt = time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.UTC)
	reserved.Tags = []model.TagReference{{ID: ids[0], Name: strings.Repeat("&", 64)}}
	first, err := taskprotocol.EncodeREST(io.Discard, reserved, true, taskcore.MaxTaskResponseJSONBytes)
	if err != nil {
		t.Fatal(err)
	}
	reserved.Tags = append(reserved.Tags, model.TagReference{ID: ids[1], Name: strings.Repeat("&", 64)})
	second, err := taskprotocol.EncodeREST(io.Discard, reserved, true, taskcore.MaxTaskResponseJSONBytes)
	if err != nil {
		t.Fatal(err)
	}
	safeCount := 1 + int((taskcore.MaxTaskResponseJSONBytes-first)/(second-first))
	if safeCount < 1 || safeCount >= len(ids) {
		t.Fatalf("fixture does not span admission boundary: %d of %d", safeCount, len(ids))
	}
	safeIDs := ids[:safeCount]
	tooMany := ids[:safeCount+1]
	var epoch string
	if err := s.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	attached, err := tasks.ReplaceTags(ctx, principal, project.ID, item.ID, current.Version, &safeIDs)
	if err != nil || attached.Version != current.Version+1 || !reflect.DeepEqual(attached.Tags, refs[:safeCount]) {
		t.Fatalf("attach receipt: count=%d, error=%v", len(attached.Tags), err)
	}
	before := snapshotTask(t, s, project.ID, item.ID)
	_, err = tasks.ReplaceTags(ctx, principal, project.ID, item.ID, before.Version, &tooMany)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "resource_limit_exceeded" {
		t.Fatalf("oversize association: %v", err)
	}
	after := snapshotTask(t, s, project.ID, item.ID)
	if !reflect.DeepEqual(after, before) {
		t.Fatal("failed admission changed the task or its references")
	}
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM task_tags WHERE project_id=$1 AND task_id=$2`, project.ID, item.ID).Scan(&count); err != nil || count != safeCount {
		t.Fatalf("failed admission persisted association: %d %v", count, err)
	}
	name := strings.Repeat("&", 64)
	if _, err := tagservice.New(s).Rename(ctx, principal, project.ID, ids[0], 1, name); err != nil {
		t.Fatalf("rename: %v", err)
	}
	read := snapshotTask(t, s, project.ID, item.ID)
	want := append([]model.TagReference(nil), refs[:safeCount]...)
	want[0].Name = name
	if read.Version != attached.Version+1 || !reflect.DeepEqual(read.Tags, want) {
		t.Fatalf("renamed readback: count=%d version=%d", len(read.Tags), read.Version)
	}
	var afterEpoch string
	if err := s.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&afterEpoch); err != nil || afterEpoch != epoch {
		t.Fatalf("tag operations changed task cache epoch: %s to %s, %v", epoch, afterEpoch, err)
	}
	for _, extended := range []bool{false, true} {
		if _, err := taskprotocol.EncodeREST(io.Discard, read, extended, taskcore.MaxTaskResponseJSONBytes); err != nil {
			t.Fatalf("renamed task response extended=%v: %v", extended, err)
		}
	}
}

// Both operations validate after acquiring the Project lock. A deleted tag must
// not be attached, while an attachment committed first is cleared by deletion.
func TestTagDeletionSerializesWithAttachAndCreate(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	caseNumber := 0
	for _, create := range []bool{false, true} {
		for _, deleteFirst := range []bool{false, true} {
			caseNumber++
			if !t.Run(fmt.Sprintf("create=%t/deleteFirst=%t", create, deleteFirst), func(t *testing.T) {
				ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
				var writers sync.WaitGroup
				defer func() {
					cancel()
					writers.Wait()
				}()
				project := queryProject(t, s, caseNumber)
				taskNumber := 10 + caseNumber
				taskID, tagID := queryID(taskNumber), queryID(20+caseNumber)
				if !create {
					queryTask(t, s, project.ID, taskNumber, model.TaskTodo)
				}
				if err := writeProjectForTest(s, ctx, project.ID, func(scope ProjectWriteScope) error {
					now, err := scope.TaskDAO().ObservedAt(ctx)
					if err != nil {
						return err
					}
					_, err = scope.TagDAO().InsertTag(ctx, model.Tag{ID: tagID, Name: "tag", NameKey: "tag", Color: "#9AA3B2", CreatedAt: now})
					return err
				}); err != nil {
					t.Fatal(err)
				}
				missing := errors.New("tag no longer exists")
				attach := func(scope ProjectWriteScope) error {
					tags, err := scope.TagDAO().ResolveTags(ctx, []string{tagID})
					if err != nil {
						return err
					}
					if len(tags) != 1 {
						return missing
					}
					if create {
						if _, err := scope.TaskDAO().CreateTask(ctx, taskID, TaskWrite{Title: "created", Status: model.TaskTodo}); err != nil {
							return err
						}
					}
					return scope.TaskTagDAO().ReplaceTaskTags(ctx, taskID, []string{tagID})
				}
				remove := func(scope ProjectWriteScope) error { return tagWitnessDelete(ctx, scope, tagID) }
				first, second := attach, remove
				if deleteFirst {
					first, second = remove, attach
				}
				type result struct {
					completion Completion
					err        error
				}
				done := make(chan result, 1)
				completion, err := s.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
					if err := first(scope); err != nil {
						return err
					}
					holder := scope.(*ProjectTx).tx.Conn().PgConn().PID()
					writers.Go(func() {
						completion, err := s.WriteProject(ctx, project.ID, second)
						done <- result{completion: completion, err: err}
					})
					testutil.WaitTransferTeamLock(t, ctx, s.Pool, "SELECT id::text FROM projects WHERE", holder)
					return nil
				})
				if err != nil || completion.Outcome != TransactionCommitted {
					t.Fatalf("first operation: %+v %v", completion, err)
				}
				var waiting result
				select {
				case waiting = <-done:
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if deleteFirst {
					if waiting.completion.Outcome != TransactionNotCommitted || !errors.Is(waiting.err, missing) {
						t.Fatalf("waiting operation admitted deleted tag: %+v %v", waiting.completion, waiting.err)
					}
				} else if waiting.completion.Outcome != TransactionCommitted || waiting.err != nil {
					t.Fatalf("waiting deletion: %+v %v", waiting.completion, waiting.err)
				}
				writers.Wait()
				testutil.AssertPoolReusable(t, s.Pool)
				var tags, associations, tasks int
				if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_tags WHERE project_id=$1 AND id=$2), (SELECT count(*) FROM task_tags WHERE project_id=$1 AND tag_id=$2), (SELECT count(*) FROM tasks WHERE project_id=$1 AND id=$3)`, project.ID, tagID, taskID).Scan(&tags, &associations, &tasks); err != nil {
					t.Fatal(err)
				}
				wantTasks := 1
				if create && deleteFirst {
					wantTasks = 0
				}
				if tags != 0 || associations != 0 || tasks != wantTasks {
					t.Fatalf("persisted tag/association/task = %d/%d/%d, want 0/0/%d", tags, associations, tasks, wantTasks)
				}
				if tasks == 1 {
					var status string
					var version int64
					if err := s.Pool.QueryRow(ctx, `SELECT status,version FROM tasks WHERE id=$1`, taskID).Scan(&status, &version); err != nil {
						t.Fatal(err)
					}
					if status != "todo" || !deleteFirst && version != 2 || deleteFirst && version != 1 {
						t.Fatalf("task status/version: %s/%d", status, version)
					}
				}
			}) {
				return
			}
		}
	}
}

func TestTagDeleteRollbackAndLostCommitReceipt(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, lostReceipt := range []bool{false, true} {
		t.Run(fmt.Sprintf("lostReceipt=%t", lostReceipt), func(t *testing.T) {
			s := isolatedStore(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			project := queryProject(t, s, 1)
			task := queryTask(t, s, project.ID, 11, model.TaskTodo)
			tagID := queryID(21)
			if err := writeProjectForTest(s, ctx, project.ID, func(scope ProjectWriteScope) error {
				now, err := scope.TaskDAO().ObservedAt(ctx)
				if err != nil {
					return err
				}
				if _, err = scope.TagDAO().InsertTag(ctx, model.Tag{ID: tagID, Name: "tag", NameKey: "tag", Color: "#9AA3B2", CreatedAt: now}); err != nil {
					return err
				}
				return scope.TaskTagDAO().ReplaceTaskTags(ctx, task.ID, []string{tagID})
			}); err != nil {
				t.Fatal(err)
			}
			var originalEpoch string
			if err := s.Pool.QueryRow(ctx, `SELECT tag_catalog_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&originalEpoch); err != nil {
				t.Fatal(err)
			}
			fault := errors.New("delete transaction fault")
			if !lostReceipt {
				completion, err := s.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
					if err := tagWitnessDelete(ctx, scope, tagID); err != nil {
						return err
					}
					return fault
				})
				if completion.Outcome != TransactionNotCommitted || !errors.Is(err, fault) {
					t.Fatalf("rollback: %+v %v", completion, err)
				}
			} else {
				tx, err := s.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				err = transact(ctx, &threadCommitResponseLoss{Tx: tx, cause: fault}, func(raw pgx.Tx) error {
					var id string
					if err := raw.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, project.ID).Scan(&id); err != nil {
						return err
					}
					return tagWitnessDelete(ctx, &ProjectTx{tx: raw, projectID: project.ID}, tagID)
				})
				completion, err := teamCompletion("project write", err)
				var failure *TransactionError
				if completion.Outcome != TransactionUnknown || !errors.As(err, &failure) || !failure.CommitAttempted || !errors.Is(err, fault) {
					t.Fatalf("lost receipt: %+v %#v %v", completion, failure, err)
				}
			}
			var tags, associations int
			var version int64
			var epoch string
			if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_tags WHERE project_id=$1 AND id=$2), (SELECT count(*) FROM task_tags WHERE project_id=$1 AND tag_id=$2), (SELECT version FROM tasks WHERE id=$3), (SELECT tag_catalog_epoch::text FROM projects WHERE id=$1)`, project.ID, tagID, task.ID).Scan(&tags, &associations, &version, &epoch); err != nil {
				t.Fatal(err)
			}
			if lostReceipt && (tags != 0 || associations != 0 || version != task.Version+1 || epoch == originalEpoch) || !lostReceipt && (tags != 1 || associations != 1 || version != task.Version || epoch != originalEpoch) {
				t.Fatalf("readback tag/association/version/epoch = %d/%d/%d/%s", tags, associations, version, epoch)
			}
		})
	}
}

func TestTaskTagWriteRemainsVisibleToSyncAcrossLockAndCommit(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, waiting := range []bool{false, true} {
		t.Run(fmt.Sprintf("waitingForProjectLock=%t", waiting), func(t *testing.T) {
			s := isolatedStore(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			project := queryProject(t, s, 1)
			item := queryTask(t, s, project.ID, 11, model.TaskTodo)
			tagID := queryID(21)
			mustQueryExec(t, s, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES($1,$2,'name','name',statement_timestamp(),statement_timestamp())`, tagID, project.ID)

			readSync := func(lower *time.Time) ([]model.TaskViewRecord, string, error) {
				var rows []model.TaskViewRecord
				var epoch string
				err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
					var err error
					epoch, err = snapshot.TaskDAO().TaskCacheEpoch(ctx, project.ID)
					if err != nil {
						return err
					}
					rows, err = snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, lower, 160)
					return err
				})
				return rows, epoch, err
			}
			var observed, releaseTime, watermark time.Time
			var epoch string
			attach := func(scope ProjectWriteScope) error {
				if _, err := scope.TaskDAO().Task(ctx, item.ID); err != nil {
					return err
				}
				tags, err := scope.TagDAO().ResolveTags(ctx, []string{tagID})
				if err != nil || len(tags) != 1 {
					return fmt.Errorf("resolve tag: %v (%d results)", err, len(tags))
				}
				observed, err = scope.TaskDAO().ObservedAt(ctx)
				if err != nil {
					return err
				}
				if err := scope.TaskTagDAO().ReplaceTaskTags(ctx, item.ID, []string{tagID}); err != nil {
					return err
				}
				return scope.TaskDAO().TouchTask(ctx, item.ID, observed)
			}
			readBeforeCommit := func() error {
				rows, currentEpoch, err := readSync(nil)
				if err != nil {
					return err
				}
				if len(rows) != 1 || rows[0].ID != item.ID || rows[0].Version != item.Version {
					return fmt.Errorf("uncommitted write leaked into sync: %#v", rows)
				}
				watermark, epoch = rows[0].UpdatedAt, currentEpoch
				return nil
			}
			if waiting {
				finished := make(chan error, 1)
				err := writeProjectForTest(s, ctx, project.ID, func(scope ProjectWriteScope) error {
					go func() { finished <- writeProjectForTest(s, ctx, project.ID, attach) }()
					waitForQueryLock(t, s, "SELECT id::text FROM projects WHERE")
					if err := readBeforeCommit(); err != nil {
						return err
					}
					return s.Pool.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&releaseTime)
				})
				if err != nil {
					t.Fatal(err)
				}
				if err := receiveQueryResult(t, ctx, finished); err != nil {
					t.Fatal(err)
				}
				if observed.Before(releaseTime) {
					t.Fatalf("timestamp was taken before the project lock: observed=%v release=%v", observed, releaseTime)
				}
			} else if err := writeProjectForTest(s, ctx, project.ID, func(scope ProjectWriteScope) error {
				if err := attach(scope); err != nil {
					return err
				}
				return readBeforeCommit()
			}); err != nil {
				t.Fatal(err)
			}
			rows, afterEpoch, err := readSync(&watermark)
			if err != nil || afterEpoch != epoch || len(rows) != 1 || rows[0].ID != item.ID || rows[0].Version != item.Version+1 || !rows[0].UpdatedAt.Equal(observed) || rows[0].UpdatedAt.Before(watermark) {
				t.Fatalf("sync missed committed tag change: rows=%#v epoch=%s/%s watermark=%v observed=%v err=%v", rows, epoch, afterEpoch, watermark, observed, err)
			}
		})
	}
}
