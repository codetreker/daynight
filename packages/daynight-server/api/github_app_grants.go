package api

import "time"

// GitHubGrantTeam is the minimal Team identity used by App administrators.
type GitHubGrantTeam struct {
	ID            string                    `json:"id"`
	Kind          string                    `json:"kind"`
	Name          *string                   `json:"name"`
	Version       string                    `json:"version"`
	PersonalOwner *GitHubGrantPersonalOwner `json:"personalOwner"`
}

type GitHubGrantPersonalOwner struct {
	UserID string  `json:"userId"`
	Name   *string `json:"name"`
}

type GitHubTeamGrant struct {
	ID        string          `json:"id"`
	AppID     string          `json:"appId"`
	Team      GitHubGrantTeam `json:"team"`
	CreatedAt time.Time       `json:"createdAt"`
}

type GitHubGrantPreview struct {
	AppID      string           `json:"appId"`
	Version    string           `json:"version"`
	TargetTeam GitHubGrantTeam  `json:"targetTeam"`
	Grant      *GitHubTeamGrant `json:"grant"`
}

type GitHubTeamGrantPage struct {
	Items      []GitHubTeamGrant `json:"items"`
	NextCursor *string           `json:"nextCursor"`
}

type GitHubTeamAppIdentity struct {
	ID          string `json:"id"`
	GitHubAppID string `json:"githubAppId"`
	Name        string `json:"name"`
	GitHubSlug  string `json:"githubSlug"`
	Version     string `json:"version"`
}

type GitHubTeamApp struct {
	GrantID   string                `json:"grantId"`
	App       GitHubTeamAppIdentity `json:"app"`
	CreatedAt time.Time             `json:"createdAt"`
}

type GitHubTeamAppPage struct {
	Items      []GitHubTeamApp `json:"items"`
	NextCursor *string         `json:"nextCursor"`
}

type GitHubGrantRevoked struct {
	AppID   string `json:"appId"`
	GrantID string `json:"grantId"`
	Revoked bool   `json:"revoked"`
}

type GitHubImpactTeamRef struct {
	ID   string  `json:"id"`
	Kind string  `json:"kind"`
	Name *string `json:"name"`
}
type GitHubImpactTeam struct {
	Team     GitHubImpactTeamRef `json:"team"`
	Projects string              `json:"projects"`
}
type GitHubAppImpact struct {
	AppID           string             `json:"appId"`
	GrantID         *string            `json:"grantId"`
	Version         string             `json:"version"`
	ImpactVersion   string             `json:"impactVersion"`
	TotalProjects   string             `json:"totalProjects"`
	VisibleProjects string             `json:"visibleProjects"`
	HiddenProjects  string             `json:"hiddenProjects"`
	Teams           []GitHubImpactTeam `json:"teams"`
	NextCursor      *string            `json:"nextCursor"`
}
type GitHubImpactProject struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	RepoURL string `json:"repoUrl"`
}
type GitHubImpactProjectPage struct {
	Items          []GitHubImpactProject `json:"items"`
	HiddenProjects string                `json:"hiddenProjects"`
	NextCursor     *string               `json:"nextCursor"`
}
