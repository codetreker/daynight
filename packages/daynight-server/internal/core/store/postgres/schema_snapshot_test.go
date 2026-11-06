package postgres

import (
	"context"
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"testing"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema/current.sql
var currentSchemaSnapshot string

var updateSchemaSnapshot = flag.Bool("update-schema-snapshot", false, "Regenerate schema/current.sql from the complete migration history.")
var schemaSnapshotPGDump = flag.String("schema-snapshot-pg-dump", "pg_dump", "PostgreSQL 18 pg_dump executable used to regenerate the schema snapshot.")

func TestSchemaSnapshotVersion(t *testing.T) {
	assertSchemaSnapshotVersion(t, currentSchemaSnapshot)
}

func TestSchemaSnapshotMatchesMigrations(t *testing.T) {
	history := emptyPool(t)
	if err := migrate(context.Background(), history, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	snapshot := currentSchemaSnapshot
	if *updateSchemaSnapshot {
		snapshot = regenerateSchemaSnapshot(t, history)
		if err := os.WriteFile("schema/current.sql", []byte(snapshot), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	assertSchemaSnapshotVersion(t, snapshot)
	want := readSchemaSnapshotState(t, history)
	var sourceSchema string
	if err := history.QueryRow(context.Background(), "SELECT current_schema()").Scan(&sourceSchema); err != nil {
		t.Fatal(err)
	}
	sourceIdentifier := pgx.Identifier{sourceSchema}.Sanitize()
	if _, err := history.Exec(context.Background(), "DROP SCHEMA "+sourceIdentifier+" CASCADE; CREATE SCHEMA "+sourceIdentifier); err != nil {
		t.Fatal(err)
	}
	actual := emptyPool(t)
	if _, err := actual.Exec(context.Background(), snapshot); err != nil {
		t.Fatal(err)
	}
	if difference := schemaSnapshotDifference(want, readSchemaSnapshotState(t, actual)); difference != "" {
		t.Fatal(difference)
	}
}

func TestSchemaSnapshotComparisonDetectsMissingState(t *testing.T) {
	history := emptyPool(t)
	if err := migrate(context.Background(), history, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	want := readSchemaSnapshotState(t, history)
	for _, test := range []struct{ name, mutation, section string }{
		{"index", "DROP INDEX tasks_project_id_id_idx", "catalog"},
		{"constraint", "ALTER TABLE tasks DROP CONSTRAINT tasks_title_check", "catalog"},
		{"seed", "DELETE FROM private_transfer_ledger", "data"},
		{"sequence state", "SELECT nextval('team_member_versions')", "sequences"},
		{"sequence ownership", "ALTER SEQUENCE team_member_versions OWNED BY team_members.version", "catalog"},
	} {
		t.Run(test.name, func(t *testing.T) {
			actual := emptyPool(t)
			if _, err := actual.Exec(context.Background(), currentSchemaSnapshot); err != nil {
				t.Fatal(err)
			}
			if _, err := actual.Exec(context.Background(), test.mutation); err != nil {
				t.Fatal(err)
			}
			if difference := schemaSnapshotDifference(want, readSchemaSnapshotState(t, actual)); !strings.HasPrefix(difference, test.section+" ") {
				t.Fatalf("missing %s escaped comparison: %q", test.name, difference)
			}
		})
	}
}

func TestSchemaSnapshotSQLNormalizationPreservesLiteralData(t *testing.T) {
	input := `-- pg_dump annotation
\restrict generated-token
SET statement_timeout = 0;
SELECT pg_catalog.set_config('search_path', '', false);
CREATE SCHEMA "generated_schema";
CREATE TABLE "generated_schema"."sample" (
    value text DEFAULT 'generated_schema.value',
    id bigint DEFAULT nextval('"generated_schema"."counter"'::regclass)
);
ALTER TABLE "generated_schema"."sample" ALTER COLUMN id SET DEFAULT "nextval"('"generated_schema"."counter"'::"regclass");
INSERT INTO "generated_schema"."sample" VALUES ('generated_schema.value', 1);
CREATE FUNCTION "generated_schema"."message"() RETURNS text LANGUAGE sql AS $body$SELECT 'generated_schema.value';$body$;
SELECT pg_catalog.setval('"generated_schema"."counter"', 7, true);
\unrestrict generated-token
`
	got := normalizeSnapshotSQL(input, "generated_schema")
	for _, want := range []string{
		`CREATE TABLE "sample"`,
		`DEFAULT 'generated_schema.value'`,
		`nextval('"counter"'::regclass)`,
		`"nextval"('"counter"'::"regclass")`,
		`INSERT INTO "sample" VALUES ('generated_schema.value', 1);`,
		`AS $body$SELECT 'generated_schema.value';$body$;`,
		`SELECT pg_catalog.setval('"counter"', 7, true);`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("normalization lost %q in %s", want, got)
		}
	}
	for _, unwanted := range []string{"CREATE SCHEMA", "SET statement_timeout", "set_config", "restrict", "pg_dump annotation"} {
		if strings.Contains(got, unwanted) {
			t.Fatalf("normalization retained %q in %s", unwanted, got)
		}
	}
}

func assertSchemaSnapshotVersion(t *testing.T, sql string) {
	t.Helper()
	line, _, _ := strings.Cut(sql, "\n")
	value, ok := strings.CutPrefix(line, "-- Schema snapshot version: ")
	version, err := strconv.ParseInt(value, 10, 64)
	if !ok || err != nil || version != schemaMigrations[len(schemaMigrations)-1].version {
		t.Fatalf("schema snapshot version %q does not match latest migration %d; regenerate schema/current.sql", line, schemaMigrations[len(schemaMigrations)-1].version)
	}
}

func regenerateSchemaSnapshot(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	var schema string
	if err := pool.QueryRow(ctx, "SELECT current_schema()").Scan(&schema); err != nil {
		t.Fatal(err)
	}
	common := []string{"--dbname", os.Getenv("DAYNIGHT_TEST_DATABASE_URL"), "--schema", (pgx.Identifier{schema}).Sanitize(), "--quote-all-identifiers", "--no-owner", "--no-acl", "--no-comments", "--no-security-labels", "--no-publications", "--no-subscriptions", "--no-tablespaces", "--no-table-access-method"}
	dump := func(extra ...string) string {
		arguments := append(slices.Clone(common), extra...)
		command := exec.CommandContext(ctx, *schemaSnapshotPGDump, arguments...)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("pg_dump failed: %v\n%s", err, output)
		}
		return normalizeSnapshotSQL(string(output), schema)
	}
	structure := dump("--schema-only")
	data := dump("--data-only", "--inserts", "--column-inserts", "--exclude-table", (pgx.Identifier{schema, "schema_migrations"}).Sanitize())
	return fmt.Sprintf("-- Schema snapshot version: %d\n\n%s\n%s", schemaMigrations[len(schemaMigrations)-1].version, structure, data)
}

type schemaSnapshotState struct {
	catalog   []string
	data      []string
	sequences []string
}

func readSchemaSnapshotState(t *testing.T, pool *pgxpool.Pool) schemaSnapshotState {
	t.Helper()
	ctx := context.Background()
	var schema string
	if err := pool.QueryRow(ctx, "SELECT current_schema()").Scan(&schema); err != nil {
		t.Fatal(err)
	}
	var result schemaSnapshotState
	for _, query := range schemaSnapshotCatalogQueries {
		rows, err := pool.Query(ctx, query)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var value string
			if err := rows.Scan(&value); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			result.catalog = append(result.catalog, normalizeSnapshotCatalogEntry(t, value, schema))
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := pool.Query(ctx, `SELECT relname,relkind::text FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind IN ('r','p','S') ORDER BY relname`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type relation struct{ name, kind string }
	var relations []relation
	for rows.Next() {
		var value relation
		if err := rows.Scan(&value.name, &value.kind); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		relations = append(relations, value)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for _, relation := range relations {
		if relation.kind == "S" {
			var last string
			var called bool
			if err := pool.QueryRow(ctx, "SELECT last_value::text,is_called FROM "+pgx.Identifier{relation.name}.Sanitize()).Scan(&last, &called); err != nil {
				t.Fatal(err)
			}
			result.sequences = append(result.sequences, fmt.Sprintf("%s: %s %t", relation.name, last, called))
			continue
		}
		if relation.name == "schema_migrations" {
			continue
		}
		var data string
		if err := pool.QueryRow(ctx, "SELECT COALESCE(jsonb_agg(row_data ORDER BY row_data),'[]'::jsonb)::text FROM (SELECT to_jsonb(row_value) AS row_data FROM "+pgx.Identifier{relation.name}.Sanitize()+" AS row_value) AS data").Scan(&data); err != nil {
			t.Fatal(err)
		}
		result.data = append(result.data, relation.name+": "+data)
	}
	slices.Sort(result.catalog)
	slices.Sort(result.data)
	slices.Sort(result.sequences)
	return result
}

func normalizeSnapshotCatalogEntry(t *testing.T, value, schema string) string {
	t.Helper()
	var fields []json.RawMessage
	if err := json.Unmarshal([]byte(value), &fields); err != nil {
		t.Fatal(err)
	}
	var kind string
	if err := json.Unmarshal(fields[0], &kind); err != nil {
		t.Fatal(err)
	}
	definitions := map[string][]int{
		"relation": {10}, "column": {4, 8}, "constraint": {9}, "index": {2},
		"sequence": {2}, "view": {2}, "function": {2, 3}, "trigger": {4},
		"rule": {3}, "type": {3, 5}, "partition": {4},
	}
	for _, index := range definitions[kind] {
		if string(fields[index]) == "null" {
			continue
		}
		var definition string
		if err := json.Unmarshal(fields[index], &definition); err != nil {
			t.Fatal(err)
		}
		normalized, err := json.Marshal(strings.TrimSpace(normalizeSnapshotSQL(definition, schema)))
		if err != nil {
			t.Fatal(err)
		}
		fields[index] = normalized
	}
	normalized, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return string(normalized)
}

func schemaSnapshotDifference(want, got schemaSnapshotState) string {
	for _, section := range []struct {
		name      string
		want, got []string
	}{{"catalog", want.catalog, got.catalog}, {"data", want.data, got.data}, {"sequences", want.sequences, got.sequences}} {
		if slices.Equal(section.want, section.got) {
			continue
		}
		missing := make([]string, 0)
		unexpected := make([]string, 0)
		for _, value := range section.want {
			if !slices.Contains(section.got, value) {
				missing = append(missing, value)
			}
		}
		for _, value := range section.got {
			if !slices.Contains(section.want, value) {
				unexpected = append(unexpected, value)
			}
		}
		return fmt.Sprintf("%s differs:\nmissing: %s\nunexpected: %s", section.name, strings.Join(missing, "\n"), strings.Join(unexpected, "\n"))
	}
	return ""
}

var schemaSnapshotCatalogQueries = []string{
	`SELECT jsonb_build_array('relation',c.relname,c.relkind,c.relpersistence,a.amname,c.relrowsecurity,c.relforcerowsecurity,c.relreplident,c.reloptions,c.relispartition,pg_get_expr(c.relpartbound,c.oid))::text
 FROM pg_class c LEFT JOIN pg_am a ON a.oid=c.relam WHERE c.relnamespace=current_schema()::regnamespace`,
	`SELECT jsonb_build_array('column',c.relname,row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum),a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid),co.collname,CASE WHEN co.collnamespace=current_schema()::regnamespace THEN 'local' ELSE cn.nspname END,a.attoptions,a.attfdwoptions)::text
 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
 WHERE c.relnamespace=current_schema()::regnamespace AND a.attnum>0 AND NOT a.attisdropped`,
	`SELECT jsonb_build_array('constraint',c.conname,r.relname,t.typname,c.contype,c.condeferrable,c.condeferred,c.convalidated,c.connoinherit,pg_get_constraintdef(c.oid,true))::text
 FROM pg_constraint c LEFT JOIN pg_class r ON r.oid=c.conrelid LEFT JOIN pg_type t ON t.oid=c.contypid WHERE c.connamespace=current_schema()::regnamespace`,
	`SELECT jsonb_build_array('index',c.relname,pg_get_indexdef(c.oid),i.indisunique,i.indisprimary,i.indisexclusion,i.indimmediate,i.indisvalid,i.indisready,i.indisreplident,i.indnullsnotdistinct)::text
 FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE c.relnamespace=current_schema()::regnamespace`,
	`SELECT jsonb_build_array('sequence',c.relname,format_type(s.seqtypid,NULL),s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle)::text
 FROM pg_class c JOIN pg_sequence s ON s.seqrelid=c.oid WHERE c.relnamespace=current_schema()::regnamespace`,
	`SELECT jsonb_build_array('sequence ownership',s.relname,t.relname,a.attname,d.deptype)::text
 FROM pg_class s JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=s.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i') JOIN pg_class t ON t.oid=d.refobjid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
 WHERE s.relnamespace=current_schema()::regnamespace AND s.relkind='S'`,
	`SELECT jsonb_build_array('view',c.relname,pg_get_viewdef(c.oid),c.relispopulated)::text FROM pg_class c WHERE c.relnamespace=current_schema()::regnamespace AND c.relkind IN ('v','m')`,
	`SELECT jsonb_build_array('function',p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid))::text FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace AND p.prokind<>'a'`,
	`SELECT jsonb_build_array('trigger',c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid))::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=current_schema()::regnamespace AND NOT t.tgisinternal`,
	`SELECT jsonb_build_array('rule',c.relname,r.rulename,pg_get_ruledef(r.oid))::text FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class WHERE c.relnamespace=current_schema()::regnamespace`,
	`SELECT jsonb_build_array('type',t.typname,t.typtype,format_type(t.typbasetype,t.typtypmod),t.typnotnull,t.typdefault,(SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid))::text
 FROM pg_type t LEFT JOIN pg_class c ON c.oid=t.typrelid WHERE t.typnamespace=current_schema()::regnamespace AND (t.typtype IN ('d','e','r','m') OR c.relkind='c')`,
	`SELECT jsonb_build_array('partition',child.relname,parent.relname,i.inhseqno,pg_get_partkeydef(parent.oid))::text FROM pg_inherits i JOIN pg_class child ON child.oid=i.inhrelid JOIN pg_class parent ON parent.oid=i.inhparent WHERE child.relnamespace=current_schema()::regnamespace`,
}

func normalizeSnapshotSQL(input, schema string) string {
	var output strings.Builder
	var statement strings.Builder
	flush := func() {
		value := strings.TrimSpace(statement.String())
		statement.Reset()
		if value == "" || strings.HasPrefix(value, "SET ") || value == "SELECT pg_catalog.set_config('search_path', '', false);" || value == "CREATE SCHEMA "+(pgx.Identifier{schema}).Sanitize()+";" {
			return
		}
		output.WriteString(value)
		output.WriteString("\n\n")
	}
	for index := 0; index < len(input); {
		rest := input[index:]
		if strings.HasPrefix(rest, "--") || strings.HasPrefix(rest, "\\restrict ") || strings.HasPrefix(rest, "\\unrestrict ") {
			end := strings.IndexByte(rest, '\n')
			if end < 0 {
				break
			}
			index += end + 1
			statement.WriteByte('\n')
			continue
		}
		if rest[0] == '\'' || rest[0] == '"' {
			quote := rest[0]
			end := 1
			for end < len(rest) {
				if rest[end] != quote {
					end++
					continue
				}
				end++
				if end < len(rest) && rest[end] == quote {
					end++
					continue
				}
				break
			}
			token := rest[:end]
			if quote == '"' && token == (pgx.Identifier{schema}).Sanitize() && end < len(rest) && rest[end] == '.' {
				index += end + 1
				continue
			}
			following := strings.TrimLeftFunc(rest[end:], unicode.IsSpace)
			sequenceArgument := strings.TrimSpace(statement.String()) == "SELECT pg_catalog.setval("
			regclass := strings.HasPrefix(following, "::regclass") || strings.HasPrefix(following, "::pg_catalog.regclass") || strings.HasPrefix(following, `::"regclass"`) || strings.HasPrefix(following, `::"pg_catalog"."regclass"`)
			if quote == '\'' && (sequenceArgument || regclass) {
				token = strings.Replace(token, "'"+(pgx.Identifier{schema}).Sanitize()+".", "'", 1)
			}
			statement.WriteString(token)
			index += end
			continue
		}
		if rest[0] == '$' {
			end := strings.IndexByte(rest[1:], '$')
			if end >= 0 {
				tag := rest[:end+2]
				valid := true
				for _, letter := range tag[1 : len(tag)-1] {
					if !unicode.IsLetter(letter) && !unicode.IsDigit(letter) && letter != '_' {
						valid = false
					}
				}
				if valid {
					closing := strings.Index(rest[len(tag):], tag)
					if closing >= 0 {
						length := len(tag)*2 + closing
						statement.WriteString(rest[:length])
						index += length
						continue
					}
				}
			}
		}
		if strings.HasPrefix(rest, schema+".") && (index == 0 || !snapshotIdentifierByte(input[index-1])) {
			index += len(schema) + 1
			continue
		}
		statement.WriteByte(rest[0])
		index++
		if rest[0] == ';' {
			flush()
		}
	}
	flush()
	return strings.TrimSpace(output.String()) + "\n"
}

func snapshotIdentifierByte(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9' || value == '_' || value == '$'
}
