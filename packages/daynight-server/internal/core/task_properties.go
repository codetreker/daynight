package core

type PullRequestProperty struct {
	URL   string
	Title string
}

type TaskProperties struct {
	PullRequests []PullRequestProperty
	Worker       *WorkerClaim
}

type TaskPropertiesPatch struct {
	PullRequests *[]PullRequestProperty
}
