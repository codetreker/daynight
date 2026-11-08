package bot

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

// Reader and Writer bind Bot operations to the caller's transaction.
type Reader struct{ tx pgx.Tx }
type Writer struct{ tx pgx.Tx }

func NewReader(tx pgx.Tx) store.BotReader   { return &Reader{tx: tx} }
func NewWriter(tx pgx.Tx) *Writer           { return &Writer{tx: tx} }
func (b *Writer) BotDAO() store.BotWriteDAO { return b }

var _ store.BotReader = (*Reader)(nil)
var _ store.BotScope = (*Writer)(nil)
var _ store.BotWriteDAO = (*Writer)(nil)

func (b *Writer) Credential(ctx context.Context, principal model.Principal) error {
	_, err := pg.ThreadCredential(ctx, b.tx, principal, " FOR SHARE")
	return err
}

func botWorker(ctx context.Context, tx pgx.Tx, ownerID, workerID, lock string) error {
	var found string
	if err := tx.QueryRow(ctx, `SELECT worker_id::text FROM workers WHERE user_id=$1 AND worker_id=$2`+lock, ownerID, workerID).Scan(&found); err != nil {
		return pg.QueryError("read bot worker", err)
	}
	return nil
}

func (b *Writer) Worker(ctx context.Context, ownerID, workerID string) error {
	return botWorker(ctx, b.tx, ownerID, workerID, " FOR KEY SHARE")
}

func (s *Reader) BotWorker(ctx context.Context, ownerID, workerID string) error {
	return botWorker(ctx, s.tx, ownerID, workerID, "")
}

const botProjection = `id::text,owner_user_id::text,worker_id::text,name,version,creation_order,request_fingerprint,
 requested_overrides,resolved_configuration,role_configuration,session_id::text,startup_result,deletion,created_at,updated_at,
 (SELECT bound.test_execution_id::text FROM task_sessions bound WHERE bound.id=bots.session_id AND bound.bot_id=bots.id)`

func scanBot(row pgx.Row) (model.Bot, error) {
	var bot model.Bot
	var overrides, configuration, role, startup, deletion []byte
	if err := row.Scan(&bot.ID, &bot.OwnerUserID, &bot.WorkerID, &bot.Name, &bot.Version, &bot.CreationOrder, &bot.RequestFingerprint,
		&overrides, &configuration, &role, &bot.SessionID, &startup, &deletion, &bot.CreatedAt, &bot.UpdatedAt, &bot.TestExecutionID); err != nil {
		return model.Bot{}, err
	}
	for _, field := range []struct {
		raw    []byte
		target any
	}{
		{overrides, &bot.RequestedOverrides}, {configuration, &bot.ResolvedConfiguration},
		{startup, &bot.StartupResult}, {role, &bot.RoleConfiguration}, {deletion, &bot.Deletion},
	} {
		if field.raw != nil {
			if err := json.Unmarshal(field.raw, field.target); err != nil {
				return model.Bot{}, err
			}
		}
	}
	bot.CreatedAt, bot.UpdatedAt = bot.CreatedAt.UTC(), bot.UpdatedAt.UTC()
	return bot, nil
}

func readBot(ctx context.Context, tx pgx.Tx, id, lock string) (model.Bot, error) {
	if lock != "" {
		var locked string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM bots WHERE id=$1`+lock, id).Scan(&locked); err != nil {
			return model.Bot{}, pg.QueryError("lock bot", err)
		}
	}
	// A lock wait can observe a newly committed Bot row while a subquery keeps
	// the statement's earlier snapshot. Read the association in a new statement
	// after acquiring the row lock so both identities describe the same binding.
	bot, err := scanBot(tx.QueryRow(ctx, `SELECT `+botProjection+` FROM bots WHERE id=$1`, id))
	if err != nil {
		return model.Bot{}, pg.QueryError("read bot", err)
	}
	return bot, nil
}

func (b *Writer) Bot(ctx context.Context, id string) (model.Bot, error) {
	return readBot(ctx, b.tx, id, " FOR UPDATE")
}

func (s *Reader) Bot(ctx context.Context, id string) (model.Bot, error) {
	return readBot(ctx, s.tx, id, "")
}

// InsertBot leaves a conflicting identity untouched. Read the row in a separate
// ReadCommitted statement to observe a concurrent creator's committed result.
func (b *Writer) InsertBot(ctx context.Context, bot model.Bot) error {
	overrides, err := json.Marshal(bot.RequestedOverrides)
	if err != nil {
		return pg.QueryError("encode bot overrides", err)
	}
	configuration, err := json.Marshal(bot.ResolvedConfiguration)
	if err != nil {
		return pg.QueryError("encode bot configuration", err)
	}
	_, err = b.tx.Exec(ctx, `INSERT INTO bots(id,owner_user_id,worker_id,name,request_fingerprint,requested_overrides,resolved_configuration,startup_result)
 VALUES($1,$2,$3,$4,$5,$6,$7,'{"state":"pending","code":null}') ON CONFLICT(id) DO NOTHING`,
		bot.ID, bot.OwnerUserID, bot.WorkerID, bot.Name, bot.RequestFingerprint, overrides, configuration)
	if err != nil {
		return pg.QueryError("insert bot", err)
	}
	return nil
}

// SaveBotDeletion advances the deletion state while the caller holds the Bot
// lock, including the cleanup receipt and obligations in the caller's transaction.
func (b *Writer) SaveBotDeletion(ctx context.Context, id string, deletion *model.BotDeletion) (model.Bot, error) {
	data, err := json.Marshal(deletion)
	if err != nil {
		return model.Bot{}, err
	}
	if _, err := b.tx.Exec(ctx, `UPDATE bots SET deletion=$2,version=version+1,updated_at=statement_timestamp() WHERE id=$1`, id, data); err != nil {
		return model.Bot{}, pg.QueryError("save bot deletion", err)
	}
	return b.Bot(ctx, id)
}

// Bots includes pending cleanup only for a specific Worker's expected inventory.
func (s *Reader) Bots(ctx context.Context, ownerID string, workerID *string, page store.Page) (store.BotPage, error) {
	afterTime, afterID := pg.PageValues(page)
	rows, err := s.tx.Query(ctx, `SELECT `+botProjection+` FROM bots WHERE owner_user_id=$1
 AND (($2::uuid IS NULL AND deletion IS NULL) OR (worker_id=$2 AND (deletion IS NULL OR deletion->'workerCleanup'->>'state'<>'completed' OR deletion->'serverCleanup'->>'state'<>'completed')))
 AND ($3::timestamptz IS NULL OR (created_at,id)>($3,$4::uuid)) ORDER BY created_at,id LIMIT $5`, ownerID, workerID, afterTime, afterID, page.Limit+1)
	if err != nil {
		return store.BotPage{}, pg.QueryError("list bots", err)
	}
	defer rows.Close()
	items := make([]model.Bot, 0, page.Limit+1)
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return store.BotPage{}, pg.QueryError("list bots", err)
		}
		item, err := scanBot(rows)
		if err != nil {
			return store.BotPage{}, pg.QueryError("list bots", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return store.BotPage{}, pg.QueryError("list bots", err)
	}
	hasMore := len(items) > page.Limit
	if hasMore {
		items = items[:page.Limit]
	}
	return store.BotPage{Items: items, HasMore: hasMore}, nil
}

// boundedBotRow adds a size flag without transferring omitted large fields.
type boundedBotRow struct {
	pgx.Row
	oversized bool
	malformed bool
}

func (r *boundedBotRow) Scan(dest ...any) error {
	return r.Row.Scan(append(dest, &r.oversized, &r.malformed)...)
}

// BotsBounded reads only fields used by the selected response. The conservative
// lower bound prevents transferring arbitrarily large historical fields while
// leaving final admission to the exact protocol encoder.
func (s *Reader) BotsBounded(ctx context.Context, ownerID string, workerID *string, page store.Page) (store.BotPage, error) {
	afterTime, afterID := pg.PageValues(page)
	malformed := `(` + strings.Join([]string{
		pg.JSONShapeError("b.requested_overrides", reflect.TypeOf(model.BotOverrides{})),
		pg.JSONShapeError("b.resolved_configuration", reflect.TypeOf(model.BotConfiguration{})),
		pg.JSONShapeError("b.role_configuration", reflect.TypeOf(model.BotRoleConfiguration{})),
		pg.JSONShapeError("b.startup_result", reflect.TypeOf(model.BotStartupResult{})),
		pg.JSONShapeError("b.deletion", reflect.TypeOf(botDeletionShape{})),
		botInvalidQuotedVersion("b.deletion"),
	}, " OR ") + `)`
	overrides := botJSONProjection("b.requested_overrides", []botField{{"workerId", true}, {"cwd", true}, {"provider", true}, {"model", true}, {"reasoningEffort", true}})
	configuration := botJSONProjection("b.resolved_configuration", []botField{{"workerId", false}, {"cwd", false}, {"provider", false}, {"model", true}, {"reasoningEffort", true}})
	args, oversizedArgs := botArgsProjection("b.resolved_configuration")
	selectionLast := botJSONLast("b.resolved_configuration", "selection", true)
	selection := `CASE WHEN ` + selectionLast + ` IS NULL OR ` + selectionLast + `='null'::jsonb THEN NULL::jsonb ELSE ` + botNestedProjection("b.resolved_configuration", "selection", true, []botField{{"schemaVersion", false}, {"modelSource", false}, {"reasoningEffortSource", false}, {"configurationGeneration", false}, {"catalogGeneration", false}}) + ` END`
	configuration = `(` + configuration + ` || jsonb_build_object('args',` + args + `,'selection',` + selection + `))`
	role := botJSONProjection("b.role_configuration", []botField{{"instructions", false}, {"revision", false}, {"digest", false}})
	startup := botJSONProjection("b.startup_result", []botField{{"state", false}, {"code", true}})
	deletion := botJSONProjection("b.deletion", []botField{{"deletionId", false}})
	deletion = `(` + deletion + ` || jsonb_build_object('requestedVersion',` + botQuotedVersion("b.deletion") + `))`
	deletion = `(` + deletion + ` || jsonb_build_object('workerCleanup',` + botNestedProjection("b.deletion", "workerCleanup", false, []botField{{"state", false}, {"code", true}}) + `,'serverCleanup',` + botNestedProjection("b.deletion", "serverCleanup", false, []botField{{"state", false}, {"code", true}}) + `))`
	rows, err := s.tx.Query(ctx, `WITH candidates AS (
        SELECT * FROM bots WHERE owner_user_id=$1
        AND (($2::uuid IS NULL AND deletion IS NULL) OR (worker_id=$2 AND (deletion IS NULL OR deletion->'workerCleanup'->>'state'<>'completed' OR deletion->'serverCleanup'->>'state'<>'completed')))
        AND ($3::timestamptz IS NULL OR (created_at,id)>($3,$4::uuid)) ORDER BY created_at,id LIMIT $5
    )
    SELECT b.id::text,b.owner_user_id::text,b.worker_id::text,
        CASE WHEN z.oversized OR z.malformed THEN '' ELSE b.name END,b.version,b.creation_order,''::text,
        CASE WHEN z.oversized OR z.malformed THEN '{}'::jsonb ELSE p.overrides END,
        CASE WHEN z.oversized OR z.malformed THEN '{}'::jsonb ELSE p.configuration END,
        CASE WHEN z.oversized OR z.malformed THEN NULL::jsonb ELSE p.role END,
        b.session_id::text,
        CASE WHEN z.oversized OR z.malformed THEN '{}'::jsonb ELSE p.startup END,
        CASE WHEN z.oversized OR z.malformed THEN NULL::jsonb ELSE p.deletion END,
        b.created_at,b.updated_at,
        (SELECT bound.test_execution_id::text FROM task_sessions bound WHERE bound.id=b.session_id AND bound.bot_id=b.id),z.oversized,z.malformed
    FROM candidates b
    CROSS JOIN LATERAL (SELECT
       CASE WHEN b.deletion IS NOT NULL THEN '{}'::jsonb ELSE `+overrides+` END AS overrides,
       CASE WHEN b.deletion IS NOT NULL THEN '{}'::jsonb ELSE `+configuration+` END AS configuration,
       CASE WHEN b.deletion IS NOT NULL OR b.role_configuration IS NULL OR b.role_configuration='null'::jsonb THEN NULL::jsonb ELSE `+role+` END AS role,
       CASE WHEN b.deletion IS NOT NULL THEN '{}'::jsonb ELSE `+startup+` END AS startup,
       CASE WHEN b.deletion IS NULL THEN NULL::jsonb ELSE `+deletion+` END AS deletion
    ) p
    CROSS JOIN LATERAL (SELECT (CASE WHEN b.deletion IS NULL THEN octet_length(b.name)::bigint ELSE 0 END +
       coalesce(octet_length(p.overrides::text),0)::bigint + coalesce(octet_length(p.configuration::text),0)::bigint +
       coalesce(octet_length(p.role::text),0)::bigint + coalesce(octet_length(p.startup::text),0)::bigint + coalesce(octet_length(p.deletion::text),0)::bigint > 16781312 OR (b.deletion IS NULL AND `+oversizedArgs+`)) AS oversized, `+malformed+` AS malformed) z
    ORDER BY b.created_at,b.id`, ownerID, workerID, afterTime, afterID, page.Limit+1)
	if err != nil {
		return store.BotPage{}, pg.QueryError("list bounded bots", err)
	}
	defer rows.Close()
	result := store.BotPage{Items: []model.Bot{}}
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return store.BotPage{}, pg.QueryError("list bounded bots", err)
		}
		row := &boundedBotRow{Row: rows}
		item, err := scanBot(row)
		if err != nil {
			return store.BotPage{}, pg.QueryError("list bounded bots", err)
		}
		if row.malformed {
			return store.BotPage{}, pg.QueryError("decode bounded bot", fmt.Errorf("stored Bot fields are malformed"))
		}
		if len(result.Items) == page.Limit {
			result.HasMore = true
			break
		}
		if row.oversized {
			if len(result.Items) == 0 {
				result.OversizedBotID = item.ID
			}
			result.HasMore = true
			break
		}
		result.Items = append(result.Items, item)
	}
	if err := rows.Err(); err != nil {
		return store.BotPage{}, pg.QueryError("list bounded bots", err)
	}
	return result, nil
}

// botDeletionShape models the JSON types read by the string-tagged version.
type botDeletionShape struct {
	ReceiptDigest    string                 `json:"receiptDigest"`
	DeletionID       string                 `json:"deletionId"`
	RequestedVersion *string                `json:"requestedVersion"`
	WorkerCleanup    model.BotCleanupResult `json:"workerCleanup"`
	ServerCleanup    model.BotCleanupResult `json:"serverCleanup"`
}

type botField struct {
	name          string
	nullOverrides bool
}

func botJSONEntries(expr string) string {
	return `jsonb_each(CASE WHEN jsonb_typeof(` + expr + `)='object' THEN ` + expr + ` ELSE '{}'::jsonb END) WITH ORDINALITY`
}

// botJSONLast follows the original JSONB iteration order used by Go's decoder.
// Null leaves scalar values unchanged, but resets pointers and slices.
func botJSONLast(expr, field string, nullOverrides bool) string {
	condition := pg.JSONFold("entry.key") + `='` + strings.ToLower(field) + `'`
	if !nullOverrides {
		condition += ` AND entry.value <> 'null'::jsonb`
	}
	return `(SELECT entry.value FROM ` + botJSONEntries(expr) + ` AS entry(key,value,ord) WHERE ` + condition + ` ORDER BY entry.ord DESC LIMIT 1)`
}

func botJSONProjection(expr string, fields []botField) string {
	values := make([]string, 0, len(fields)*2)
	for _, field := range fields {
		values = append(values, `'`+field.name+`'`, botJSONLast(expr, field.name, field.nullOverrides))
	}
	return `jsonb_build_object(` + strings.Join(values, ",") + `)`
}

// A non-pointer nested object merges aliases, ignoring null. A pointer object
// resets on null; only fields after the last reset can survive.
func botNestedLast(expr, outer, inner string, reset, nullOverrides bool) string {
	condition := pg.JSONFold("parent.key") + `='` + strings.ToLower(outer) + `' AND ` + pg.JSONFold("child.key") + `='` + strings.ToLower(inner) + `'`
	if !nullOverrides {
		condition += ` AND child.value <> 'null'::jsonb`
	}
	if reset {
		resetPos := `(SELECT max(resetrow.ord) FROM ` + botJSONEntries(expr) + ` AS resetrow(key,value,ord) WHERE ` + pg.JSONFold("resetrow.key") + `='` + strings.ToLower(outer) + `' AND resetrow.value='null'::jsonb)`
		condition += ` AND parent.ord > coalesce(` + resetPos + `,0)`
	}
	return `(SELECT child.value FROM ` + botJSONEntries(expr) + ` AS parent(key,value,ord) CROSS JOIN LATERAL ` + botJSONEntries("parent.value") + ` AS child(key,value,ord) WHERE ` + condition + ` ORDER BY parent.ord DESC,child.ord DESC LIMIT 1)`
}

func botNestedProjection(expr, outer string, reset bool, fields []botField) string {
	values := make([]string, 0, len(fields)*2)
	for _, field := range fields {
		values = append(values, `'`+field.name+`'`, botNestedLast(expr, outer, field.name, reset, field.nullOverrides))
	}
	return `jsonb_build_object(` + strings.Join(values, ",") + `)`
}

// Go reuses slice capacity across nonempty array aliases. A null element leaves
// an existing string unchanged, even after an intervening shorter array. Null
// or empty array values reset the slice and discard that earlier capacity.
func botArgsProjection(expr string) (string, string) {
	last := botJSONLast(expr, "args", true)
	lastCount := `CASE WHEN jsonb_typeof(` + last + `)='array' THEN jsonb_array_length(` + last + `) ELSE 0 END`
	oversized := `(` + lastCount + ` > 2796203)`
	resetPos := `(SELECT max(resetrow.ord) FROM ` + botJSONEntries(expr) + ` AS resetrow(key,value,ord) WHERE ` + pg.JSONFold("resetrow.key") + `='args' AND (resetrow.value='null'::jsonb OR CASE WHEN jsonb_typeof(resetrow.value)='array' THEN jsonb_array_length(resetrow.value)=0 ELSE false END))`
	value := `(SELECT entry.value->indexvalue.i FROM ` + botJSONEntries(expr) + ` AS entry(key,value,ord) WHERE ` + pg.JSONFold("entry.key") + `='args' AND entry.ord > coalesce(` + resetPos + `,0) AND CASE WHEN jsonb_typeof(entry.value)='array' THEN jsonb_array_length(entry.value)>indexvalue.i ELSE false END AND jsonb_typeof(entry.value->indexvalue.i)='string' ORDER BY entry.ord DESC LIMIT 1)`
	array := `(SELECT jsonb_agg(coalesce(` + value + `,'""'::jsonb) ORDER BY indexvalue.i) FROM generate_series(0,` + lastCount + `-1) AS indexvalue(i))`
	return `CASE WHEN ` + last + ` IS NULL OR ` + last + `='null'::jsonb THEN NULL::jsonb WHEN jsonb_typeof(` + last + `)<>'array' THEN ` + last + ` WHEN ` + lastCount + `=0 OR ` + oversized + ` THEN '[]'::jsonb ELSE ` + array + ` END`, oversized
}

func botInvalidQuotedVersion(expr string) string {
	return `EXISTS (SELECT 1 FROM ` + botJSONEntries(expr) + ` AS entry(key,value,ord) WHERE ` + pg.JSONFold("entry.key") + `='requestedversion' AND jsonb_typeof(entry.value)='string' AND entry.value#>>'{}'<>'null' AND ((entry.value#>>'{}') !~ '^[+-]?[0-9]+$' OR NOT pg_input_is_valid(entry.value#>>'{}','bigint')))`
}

// Go treats the quoted literal "null" as a no-op for a ,string integer, just
// like JSON null. Earlier aliases may still have set the value.
func botQuotedVersion(expr string) string {
	return `(SELECT entry.value FROM ` + botJSONEntries(expr) + ` AS entry(key,value,ord) WHERE ` + pg.JSONFold("entry.key") + `='requestedversion' AND entry.value <> 'null'::jsonb AND entry.value <> '"null"'::jsonb ORDER BY entry.ord DESC LIMIT 1)`
}
