package github

import (
	"context"
	"fmt"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

func TestRepositoryResolvesRenamedIdentityAfterOldPathForbidden(t *testing.T) {
	for _, correct := range []bool{true, false} {
		t.Run(fmt.Sprintf("matching_identity=%t", correct), func(t *testing.T) {
			app, installation, repository := int64(10), int64(20), int64(30)
			old := "old/name"
			var calls []string
			upstream := executorRemote{}
			upstream.verify = func(_ context.Context, id int64, owner, name string) (githubpr.RepositoryObservation, error) {
				if id != installation {
					t.Fatalf("installation %d", id)
				}
				calls = append(calls, "verify "+owner+"/"+name)
				if owner == "old" && name == "name" {
					return githubpr.RepositoryObservation{}, &remote.Error{Code: "permission_denied", Status: 403}
				}
				if owner != "new" || name != "name" {
					t.Fatalf("unexpected target %s/%s", owner, name)
				}
				id = repository
				if !correct {
					id++
				}
				return githubpr.RepositoryObservation{ID: id, FullName: "new/name", Private: true}, nil
			}
			upstream.resolve = func(_ context.Context, id, stable int64) (githubpr.RepositoryObservation, error) {
				calls = append(calls, "resolve")
				if id != installation || stable != repository {
					t.Fatalf("resolve identity %d %d", id, stable)
				}
				return githubpr.RepositoryObservation{ID: repository, FullName: "new/name", Private: true}, nil
			}
			r := run{e: &Executor{remote: upstream}, connection: githubpr.Connection{AppID: &app, InstallationID: &installation, RepositoryID: &repository, RepositoryFullName: &old}}
			got, err := r.repository(context.Background())
			if !reflect.DeepEqual(calls, []string{"verify old/name", "resolve", "verify new/name"}) {
				t.Fatalf("calls %v", calls)
			}
			if correct {
				if err != nil || got.ID != repository || got.FullName != "new/name" || !got.Private {
					t.Fatalf("repository %+v error %v", got, err)
				}
			} else if err == nil {
				t.Fatalf("accepted changed identity: %+v", got)
			}
		})
	}
}
