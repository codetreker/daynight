//go:build integration

package main

import (
	"net/http"
	"testing"
)

type catalogTag struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	Name      string `json:"name"`
	Version   int64  `json:"version"`
	Usage     struct {
		Tasks int `json:"tasks"`
		Goals int `json:"goals"`
	} `json:"usage"`
}

type tagColors struct {
	CatalogEpoch string `json:"catalogEpoch"`
	Items        []struct {
		ID      string `json:"id"`
		State   string `json:"state"`
		Version int64  `json:"version"`
		Color   string `json:"color"`
	} `json:"items"`
}

func serverAPITagCatalogNormalFlow(t *testing.T, f *fixture) {
	project := createProject(t, f, "API tag catalog")
	path := "/api/v1/projects/" + project.ID + "/tags"
	created := requestJSON[catalogTag](t, f, http.MethodPost, path, map[string]any{"name": "Backend", "color": "#d85656"}, http.StatusCreated)
	if created.ID == "" || created.ProjectID != project.ID || created.Name != "Backend" || created.Version != 1 {
		t.Fatalf("created tag differs: %+v", created)
	}
	createdColors := requestJSON[tagColors](t, f, http.MethodPost, path+"/colors/resolve", map[string]any{"tagIds": []string{created.ID}}, http.StatusOK)
	if createdColors.CatalogEpoch == "" || len(createdColors.Items) != 1 || createdColors.Items[0].ID != created.ID || createdColors.Items[0].State != "found" || createdColors.Items[0].Version != created.Version || createdColors.Items[0].Color != "#D85656" {
		t.Fatalf("created tag color differs: %+v", createdColors)
	}
	itemPath := path + "/" + created.ID
	renamed := requestJSON[catalogTag](t, f, http.MethodPatch, itemPath, map[string]any{"version": created.Version, "name": "Platform", "color": "#123abc"}, http.StatusOK)
	if renamed.ID != created.ID || renamed.ProjectID != project.ID || renamed.Name != "Platform" || renamed.Version != created.Version+1 {
		t.Fatalf("renamed tag differs: %+v", renamed)
	}
	read := requestJSON[catalogTag](t, f, http.MethodGet, itemPath, nil, http.StatusOK)
	if read.ID != renamed.ID || read.ProjectID != project.ID || read.Name != renamed.Name || read.Version != renamed.Version || read.Usage.Tasks != 0 || read.Usage.Goals != 0 {
		t.Fatalf("tag read differs: %+v", read)
	}
	updatedColors := requestJSON[tagColors](t, f, http.MethodPost, path+"/colors/resolve", map[string]any{"tagIds": []string{created.ID}}, http.StatusOK)
	if updatedColors.CatalogEpoch == "" || updatedColors.CatalogEpoch == createdColors.CatalogEpoch || len(updatedColors.Items) != 1 || updatedColors.Items[0].ID != renamed.ID || updatedColors.Items[0].State != "found" || updatedColors.Items[0].Version != renamed.Version || updatedColors.Items[0].Color != "#123ABC" {
		t.Fatalf("updated tag color differs: %+v", updatedColors)
	}
	page := requestJSON[struct {
		Items        []catalogTag `json:"items"`
		CatalogEpoch string       `json:"catalogEpoch"`
		NextCursor   *string      `json:"nextCursor"`
	}](t, f, http.MethodGet, path, nil, http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].ID != created.ID || page.Items[0].Name != renamed.Name || page.CatalogEpoch == "" || page.NextCursor != nil {
		t.Fatalf("tag catalog differs: %+v", page)
	}
	resolved := requestJSON[struct {
		Items []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"items"`
	}](t, f, http.MethodPost, path+"/resolve", map[string]any{"tagIds": []string{created.ID}}, http.StatusOK)
	if len(resolved.Items) != 1 || resolved.Items[0].ID != created.ID || resolved.Items[0].Name != renamed.Name {
		t.Fatalf("resolved tags differ: %+v", resolved)
	}
	receipt := requestJSON[struct {
		ProjectID string `json:"projectId"`
		TagID     string `json:"tagId"`
		Deleted   bool   `json:"deleted"`
	}](t, f, http.MethodDelete, itemPath, map[string]any{"version": renamed.Version, "confirm": true}, http.StatusOK)
	if receipt.ProjectID != project.ID || receipt.TagID != created.ID || !receipt.Deleted {
		t.Fatalf("tag deletion receipt differs: %+v", receipt)
	}
	empty := requestJSON[struct {
		Items        []catalogTag `json:"items"`
		CatalogEpoch string       `json:"catalogEpoch"`
	}](t, f, http.MethodGet, path, nil, http.StatusOK)
	if len(empty.Items) != 0 || empty.CatalogEpoch == "" || empty.CatalogEpoch == page.CatalogEpoch {
		t.Fatalf("deleted tag remains in catalog: %+v", empty)
	}
}
