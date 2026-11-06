package service

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"

	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

func serviceDatabaseURL(t *testing.T) string {
	return testsupport.ServiceDatabaseURL(t)
}

func projectService(t *testing.T) (*projectservice.Projects, *postgres.Store, string, model.Principal) {
	return testsupport.ProjectService(t)
}

func servicePrincipal(t *testing.T, database *postgres.Store) model.Principal {
	return testsupport.ServicePrincipal(t, database)
}

func requireIdentityOperationalError(t *testing.T, err error) {
	t.Helper()
	var fault *model.Fault
	var databaseError *store.Error
	if err == nil || errors.As(err, &fault) || !errors.As(err, &databaseError) || databaseError.Unwrap() == nil {
		t.Fatalf("expected retained database failure, got %#v", err)
	}
}

func fixtureIdentitySession(t *testing.T, database *postgres.Store, user model.User, session model.Session) model.Principal {
	return testsupport.FixtureIdentitySession(t, database, user, session)
}
