package store

import (
	"context"
	"encoding/hex"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func storeAssigneeUser(t *testing.T, database *Store, projectID string, number int, member bool) string {
	t.Helper()
	id := queryID(number)
	mustQueryExec(t, database, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1::uuid,$1::uuid::text,now(),now())`, id)
	if member {
		mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, projectID, id)
	}
	return id
}

func storeAssigneeRead(t *testing.T, database *Store, projectID string, ids []string) (model.TaskAssignees, error) {
	t.Helper()
	var result model.TaskAssignees
	err := database.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error {
		var err error
		if ids == nil {
			result, err = snapshot.TaskAssignees(context.Background(), projectID)
		} else {
			result, err = snapshot.ResolveTaskAssignees(context.Background(), projectID, ids)
		}
		return err
	})
	return result, err
}

func assertStoreAssignees(t *testing.T, result model.TaskAssignees, expected map[string]bool, unresolved []string) {
	t.Helper()
	if result.Items == nil || result.UnresolvedUserIDs == nil || len(result.Items) != len(expected) {
		t.Fatalf("assignee result shape: %#v want %v", result, expected)
	}
	ids := make([]string, 0, len(result.Items))
	for _, item := range result.Items {
		access, exists := expected[item.UserID]
		if !exists || access != item.HasProjectAccess {
			t.Fatalf("unexpected project person: %#v", item)
		}
		ids = append(ids, item.UserID)
	}
	want := append([]string{}, unresolved...)
	slices.Sort(want)
	if !slices.IsSorted(ids) || len(slices.Compact(slices.Clone(ids))) != len(ids) || !slices.Equal(result.UnresolvedUserIDs, want) {
		t.Fatalf("identity order, uniqueness or unresolved scope: %#v want %v", result, want)
	}
}

func TestTaskAssigneeStoreCatalogueAndBoundedResolution(t *testing.T) {
	database := isolatedStore(t)
	project, other := queryProject(t, database, 1), queryProject(t, database, 2)
	current := storeAssigneeUser(t, database, project.ID, 101, true)
	named := storeAssigneeUser(t, database, project.ID, 102, true)
	former := storeAssigneeUser(t, database, project.ID, 103, true)
	deleted := storeAssigneeUser(t, database, project.ID, 104, true)
	foreign := storeAssigneeUser(t, database, other.ID, 105, true)
	unrelated := storeAssigneeUser(t, database, project.ID, 106, false)
	name, avatar := "Canonical name", "https://images.example.test/person.png"
	mustQueryExec(t, database, `UPDATE users SET name=$2,avatar_url=$3 WHERE id=$1`, named, name, avatar)
	for _, seed := range []struct {
		projectID, userID string
		number            int
		status            model.TaskStatus
	}{
		{project.ID, named, 11, model.TaskTodo}, {project.ID, former, 12, model.TaskDone},
		{project.ID, former, 13, model.TaskInProgress}, {project.ID, deleted, 14, model.TaskTodo},
		{other.ID, foreign, 15, model.TaskTodo},
	} {
		queryTask(t, database, seed.projectID, seed.number, seed.status)
		mustQueryExec(t, database, `UPDATE tasks SET assigned_to=$2 WHERE id=$1`, queryID(seed.number), seed.userID)
	}
	mustQueryExec(t, database, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, queryID(14))
	mustQueryExec(t, database, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=ANY($2::uuid[])`, project.ID, []string{former, deleted})
	var before string
	if err := database.Pool.QueryRow(context.Background(), `SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM tasks t`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	catalogue, err := storeAssigneeRead(t, database, project.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	var ownerID string
	if err := database.Pool.QueryRow(context.Background(), `SELECT personal_user_id::text FROM teams WHERE id=$1`, project.Ownership.TeamID).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	assertStoreAssignees(t, catalogue, map[string]bool{ownerID: true, current: true, named: true, former: false}, nil)
	people := make(map[string]model.TaskAssignee, len(catalogue.Items))
	for _, person := range catalogue.Items {
		people[person.UserID] = person
	}
	if people[current].Name != nil || people[current].AvatarURL != nil || people[named].Name == nil || *people[named].Name != name || people[named].AvatarURL == nil || *people[named].AvatarURL != avatar {
		t.Fatalf("nullable canonical profile facts changed: %#v", catalogue)
	}
	requested := []string{current, former, deleted, foreign, unrelated, queryID(107)}
	resolved, err := storeAssigneeRead(t, database, project.ID, requested)
	if err != nil {
		t.Fatal(err)
	}
	assertStoreAssignees(t, resolved, map[string]bool{current: true, former: false}, []string{deleted, foreign, unrelated, queryID(107)})
	var after string
	if err := database.Pool.QueryRow(context.Background(), `SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM tasks t`).Scan(&after); err != nil || before != after {
		t.Fatal("people reads changed task facts", err)
	}
	empty, err := storeAssigneeRead(t, database, queryID(999), nil)
	if err != nil {
		t.Fatal(err)
	}
	assertStoreAssignees(t, empty, map[string]bool{}, nil)
}

func TestTaskAssigneeProfileRequiresMatchingIdentity(t *testing.T) {
	id, other := queryID(100), queryID(200)
	person, err := taskAssigneeProfile(id, &id, nil, nil, false)
	if err != nil || person.UserID != id || person.Name != nil || person.AvatarURL != nil || person.HasProjectAccess {
		t.Fatalf("valid nullable profile rejected: %#v %v", person, err)
	}
	for _, profileID := range []*string{nil, &other} {
		person, err := taskAssigneeProfile(id, profileID, nil, nil, true)
		if err == nil || !reflect.DeepEqual(person, model.TaskAssignee{}) {
			t.Fatal("missing or different person's profile became a qualified identity")
		}
	}
}

func TestTaskAssigneeContentVersionDistinguishesPublicProfileFacts(t *testing.T) {
	id := queryID(100)
	empty, escaped, unicode := "", "<>&\"\\\n", "中文 😀"
	profiles := []struct {
		userID       string
		name, avatar *string
	}{
		{id, nil, nil}, {id, &empty, nil}, {id, nil, &empty},
		{id, &escaped, &unicode}, {id, &unicode, &escaped},
		{queryID(101), nil, nil},
	}
	versions := make(map[string]bool, len(profiles))
	for _, profile := range profiles {
		version := taskAssigneeContentVersion(profile.userID, profile.name, profile.avatar)
		decoded, err := hex.DecodeString(version)
		if err != nil || len(decoded) != 32 || version != strings.ToLower(version) || versions[version] {
			t.Fatalf("distinct public profile facts produced an invalid or repeated version: %q %v", version, err)
		}
		versions[version] = true
		member, err := taskAssigneeProfile(profile.userID, &profile.userID, profile.name, profile.avatar, true)
		if err != nil {
			t.Fatal(err)
		}
		former, err := taskAssigneeProfile(profile.userID, &profile.userID, profile.name, profile.avatar, false)
		if err != nil || member.Version != version || former.Version != version {
			t.Fatalf("project access changed the content version: %#v %#v %v", member, former, err)
		}
	}
}

func BenchmarkTaskAssigneeContentVersion(b *testing.B) {
	avatar := "data:image/png;base64," + strings.Repeat("a", 235_600)
	for _, test := range []struct {
		name   string
		avatar *string
	}{
		{"nullable", nil},
		{"inline-avatar-236KB", &avatar},
	} {
		b.Run(test.name, func(b *testing.B) {
			b.ReportAllocs()
			if test.avatar != nil {
				b.SetBytes(int64(len(*test.avatar)))
			}
			for b.Loop() {
				taskAssigneeContentVersion("00000000-0000-4000-8000-000000000100", nil, test.avatar)
			}
		})
	}
}

func TestTaskAssigneeStoreRejectsMissingQualifiedProfiles(t *testing.T) {
	for _, retained := range []bool{false, true} {
		database := isolatedStore(t)
		project := queryProject(t, database, 1)
		storeAssigneeUser(t, database, project.ID, 101, true)
		missing := storeAssigneeUser(t, database, project.ID, 102, true)
		if retained {
			queryTask(t, database, project.ID, 11, model.TaskDone)
			mustQueryExec(t, database, `UPDATE tasks SET assigned_to=$2 WHERE id=$1`, queryID(11), missing)
			mustQueryExec(t, database, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, missing)
		}
		mustQueryExec(t, database, `DELETE FROM users WHERE id=$1`, missing)
		resolved, err := storeAssigneeRead(t, database, project.ID, []string{queryID(101)})
		if err != nil {
			t.Fatalf("unrequested missing profile broke bounded resolution: %v", err)
		}
		assertStoreAssignees(t, resolved, map[string]bool{queryID(101): true}, nil)
		for _, ids := range [][]string{nil, {queryID(101), missing}} {
			result, err := storeAssigneeRead(t, database, project.ID, ids)
			var failure *Error
			if !errors.As(err, &failure) || errors.Is(err, model.ErrNotFound) || len(result.Items) != 0 || len(result.UnresolvedUserIDs) != 0 {
				t.Fatalf("qualified missing profile became partial/unresolved: %#v %v", result, err)
			}
		}
	}
}

func TestTaskAssigneeStoreQueryAndRowFailuresPreserveCauses(t *testing.T) {
	for _, kind := range []string{"query", "scan", "iteration"} {
		for _, resolve := range []bool{false, true} {
			database := isolatedStore(t)
			project := queryProject(t, database, 1)
			storeAssigneeUser(t, database, project.ID, 101, true)
			storeAssigneeUser(t, database, project.ID, 102, true)
			switch kind {
			case "query":
				mustQueryExec(t, database, `DROP TABLE tasks CASCADE`)
			case "scan":
				mustQueryExec(t, database, `ALTER TABLE users RENAME TO assignee_user_source;
					CREATE VIEW users AS SELECT id,uniauth_id,email,email_verified,'\x01'::bytea AS name,avatar_url,created_at,updated_at FROM assignee_user_source`)
			case "iteration":
				mustQueryExec(t, database, `CREATE FUNCTION refuse_assignee_profile(id uuid) RETURNS text LANGUAGE plpgsql AS $$
					BEGIN IF id='00000000-0000-4000-8000-000000000102'::uuid THEN RAISE EXCEPTION USING ERRCODE='P1032',MESSAGE='private profile diagnostic'; END IF; RETURN 'Visible'; END $$;
					ALTER TABLE users RENAME TO assignee_user_source;
					CREATE VIEW users AS SELECT id,uniauth_id,email,email_verified,refuse_assignee_profile(id) AS name,avatar_url,created_at,updated_at FROM assignee_user_source`)
			}
			var ids []string
			if resolve {
				ids = []string{queryID(101), queryID(102)}
			}
			result, err := storeAssigneeRead(t, database, project.ID, ids)
			var failure *Error
			if !errors.As(err, &failure) || len(result.Items) != 0 || len(result.UnresolvedUserIDs) != 0 || strings.Contains(err.Error(), "private profile") {
				t.Fatalf("%s failure became partial or unsafe: %#v %v", kind, result, err)
			}
			if kind == "query" || kind == "iteration" {
				var cause *pgconn.PgError
				code := "42P01"
				if kind == "iteration" {
					code = "P1032"
				}
				if !errors.As(err, &cause) || cause.Code != code {
					t.Fatalf("%s failure lost PostgreSQL cause: %v", kind, err)
				}
			}
		}
	}
}

type assigneeStoreCancelTracer struct{ cancel context.CancelFunc }

func (tracer assigneeStoreCancelTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if data.SQL == taskAssigneesCatalogueQuery || data.SQL == taskAssigneesResolveQuery {
		tracer.cancel()
	}
	return ctx
}

func (assigneeStoreCancelTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestTaskAssigneeStoreQueryCancellation(t *testing.T) {
	for _, resolve := range []bool{false, true} {
		database := isolatedStore(t)
		project := queryProject(t, database, 1)
		storeAssigneeUser(t, database, project.ID, 101, true)
		ctx, cancel := context.WithCancel(context.Background())
		config := database.Pool.Config()
		config.ConnConfig.Tracer = assigneeStoreCancelTracer{cancel: cancel}
		pool, err := pgxpool.NewWithConfig(context.Background(), config)
		if err != nil {
			t.Fatal(err)
		}
		traced := &Store{Pool: pool}
		var result model.TaskAssignees
		err = traced.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
			var err error
			if resolve {
				result, err = snapshot.ResolveTaskAssignees(ctx, project.ID, []string{queryID(101)})
			} else {
				result, err = snapshot.TaskAssignees(ctx, project.ID)
			}
			return err
		})
		cancel()
		pool.Close()
		if !errors.Is(err, context.Canceled) || len(result.Items) != 0 || len(result.UnresolvedUserIDs) != 0 {
			t.Fatalf("directory cancellation lost cause or returned data: %#v %v", result, err)
		}
	}
}

func TestTaskAssignmentStoreFiltersAndInvalidSelectors(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	first := queryTask(t, database, project.ID, 11, model.TaskTodo)
	second := queryTask(t, database, project.ID, 12, model.TaskTodo)
	queryTask(t, database, project.ID, 13, model.TaskTodo)
	userID := queryID(101)
	mustQueryExec(t, database, `UPDATE tasks SET assigned_to=$2 WHERE id=$1`, second.ID, userID)
	for _, test := range []struct {
		filter model.TaskAssignmentFilter
		want   []string
	}{
		{model.TaskAssignmentFilter{}, []string{first.ID, second.ID, queryID(13)}},
		{model.TaskAssignmentFilter{Mode: model.TaskAssignmentUnassigned}, []string{first.ID, queryID(13)}},
		{model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: userID}, []string{second.ID}},
	} {
		if err := database.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error {
			page, err := snapshot.Tasks(context.Background(), project.ID, TaskQuery{Page: Page{Limit: 10}, AssignedTo: test.filter})
			var ids []string
			for _, item := range page.Items {
				ids = append(ids, item.ID)
			}
			if err != nil || !slices.Equal(ids, test.want) || page.HasMore {
				t.Fatalf("native assignment selector: %#v got %v want %v, %v", test.filter, ids, test.want, err)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	for _, invalid := range []model.TaskAssignmentFilter{{Mode: model.TaskAssignmentAll, UserID: userID}, {Mode: model.TaskAssignmentUnassigned, UserID: userID}, {Mode: "unknown"}} {
		err := database.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error {
			page, err := snapshot.Tasks(context.Background(), project.ID, TaskQuery{Page: Page{Limit: 10}, AssignedTo: invalid})
			if len(page.Items) != 0 {
				t.Fatal("invalid selector returned an unfiltered page")
			}
			return err
		})
		if err == nil {
			t.Fatalf("invalid assignment selector silently became all: %#v", invalid)
		}
	}
}
