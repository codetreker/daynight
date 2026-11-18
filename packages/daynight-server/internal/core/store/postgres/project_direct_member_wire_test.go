package postgres

import (
	"context"
	"errors"
	"net"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestProjectDirectMemberWireCommitLoss(t *testing.T) {
	parallelRootDatabaseTest(t)
	db, actor, target, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	var armed, lost atomic.Bool
	config := db.Pool.Config().Copy()
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
	service := projectservice.NewDirectMembers(&Store{Pool: pool}, "https://example.test/api/v1")
	result, err := service.AddExistingMember(ctx, actor, project.ID, target.UserID, actor.UserID)
	var failure *store.TransactionError
	databaseFailure, _ := store.DatabaseErrorFacts(err)
	if !reflect.DeepEqual(result, core.ExistingMemberResult{}) || !lost.Load() || !errors.As(err, &failure) || failure.Phase != "commit" || !failure.CommitAttempted || failure.Outcome != store.TransactionUnknown || !databaseFailure {
		t.Fatalf("lost confirmation: result=%+v lost=%t transaction=%+v error=%v", result, lost.Load(), failure, err)
	}
	var role string
	var version int64
	var inherited bool
	if err := db.Pool.QueryRow(ctx, `SELECT g.role,g.version,EXISTS(SELECT 1 FROM project_ownership o JOIN team_members m ON m.team_id=o.team_id WHERE o.project_id=$1 AND m.user_id=$2) FROM project_grants g WHERE g.project_id=$1 AND g.user_id=$2`, project.ID, target.UserID).Scan(&role, &version, &inherited); err != nil || role != "member" || version <= 0 || inherited {
		t.Fatalf("independent read: role=%s version=%d inherited=%t error=%v", role, version, inherited, err)
	}
}
