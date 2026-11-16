package github

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

type AppMetadata = githubpr.AppMetadata

type CreateAppInput struct {
	ID, Name                                     string
	GitHubAppID                                  int64
	PrivateKeyPEM, WebhookSecret, ExpectedUserID string
}

type ListAppsInput struct {
	Limit  int
	Cursor string
}
type AppPage struct {
	Items      []AppMetadata
	NextCursor *string
}

// ValidateCreateApp checks the actor and input before any external proof or write.
func ValidateCreateApp(p model.Principal, in CreateAppInput) error {
	if err := team.RequireActor(p, in.ExpectedUserID); err != nil {
		return err
	}
	id, err := model.CanonicalID(in.ID)
	if err != nil || id != in.ID {
		return invalid("App ID must be a canonical UUID.")
	}
	if in.GitHubAppID < 1 {
		return invalid("GitHub App ID must be positive.")
	}
	if !utf8.ValidString(in.Name) || strings.ContainsRune(in.Name, 0) || strings.TrimSpace(in.Name) == "" || len(in.Name) > 1024 || utf8.RuneCountInString(in.Name) > 256 {
		return invalid("App name must be nonempty Unicode text of at most 256 characters and 1024 bytes without NUL.")
	}
	if !utf8.ValidString(in.PrivateKeyPEM) || len(in.PrivateKeyPEM) == 0 || len(in.PrivateKeyPEM) > 65536 {
		return invalid("Private key PEM must be nonempty UTF-8 of at most 65536 bytes.")
	}
	if !utf8.ValidString(in.WebhookSecret) || len(in.WebhookSecret) == 0 || len(in.WebhookSecret) > 4096 {
		return invalid("Webhook secret must be nonempty UTF-8 of at most 4096 bytes.")
	}
	return nil
}

func ValidateAppRead(p model.Principal, id string) error {
	if err := model.RequirePrincipal(p); err != nil {
		return err
	}
	canonical, err := model.CanonicalID(id)
	if err != nil || canonical != id {
		return invalid("App ID must be a canonical UUID.")
	}
	return nil
}

// ListApps applies actor-bound pagination before invoking the storage query.
func ListApps(ctx context.Context, dao store.GitHubAppReadDAO, p model.Principal, in ListAppsInput) (AppPage, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return AppPage{}, err
	}
	if in.Limit == 0 {
		in.Limit = 25
	}
	var cursor *string
	if in.Cursor != "" {
		cursor = &in.Cursor
	}
	scope := query.ListScope{Kind: "github_apps", UserID: p.UserID}
	page, err := query.ListPage(model.PageRequest{Limit: in.Limit, Cursor: cursor}, scope)
	if err != nil {
		return AppPage{}, err
	}
	result, err := dao.List(ctx, store.GitHubAppQuery{ActorID: p.UserID, After: page.After, Limit: page.Limit})
	if err != nil {
		return AppPage{}, err
	}
	out := AppPage{Items: result.Items}
	if out.Items == nil {
		out.Items = []AppMetadata{}
	}
	if result.HasMore && len(result.Items) > 0 {
		last := result.Items[len(result.Items)-1]
		c, err := query.EncodeListCursor(scope, last.CreatedAt, last.ID)
		if err != nil {
			return AppPage{}, err
		}
		out.NextCursor = &c
	}
	return out, nil
}
