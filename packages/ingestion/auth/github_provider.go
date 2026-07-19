package auth

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	gh "github.com/opslane/opslane/packages/ingestion/github"
)

// GitHubProvider adapts the existing GitHub OAuth client to AuthProvider.
type GitHubProvider struct {
	ClientID     string
	ClientSecret string
}

func (GitHubProvider) Name() string { return "github" }

func (p GitHubProvider) AuthorizeURL(req AuthRequest) (string, error) {
	if p.ClientID == "" {
		return "", fmt.Errorf("GitHub OAuth is not configured")
	}
	params := url.Values{
		"client_id":    {p.ClientID},
		"redirect_uri": {req.RedirectURI},
		"scope":        {"user:email"},
		"state":        {req.State},
	}
	return "https://github.com/login/oauth/authorize?" + params.Encode(), nil
}

func (p GitHubProvider) ExchangeCode(_ context.Context, code string) (Identity, error) {
	token, err := gh.ExchangeOAuthCode(p.ClientID, p.ClientSecret, code)
	if err != nil {
		return Identity{}, err
	}
	user, err := gh.GetUser(token.AccessToken)
	if err != nil {
		return Identity{}, err
	}

	email := strings.TrimSpace(user.Email)
	emailVerified := false
	// Fetching /user/emails both fills private primary emails and establishes the
	// verified-email assertion used for safe account linking.
	emails, emailErr := gh.GetUserEmails(token.AccessToken)
	if emailErr == nil {
		for _, candidate := range emails {
			if !candidate.Verified {
				continue
			}
			if strings.EqualFold(candidate.Email, email) {
				emailVerified = true
			}
			if email == "" && candidate.Primary {
				email = candidate.Email
				emailVerified = true
			}
		}
	}
	if email == "" {
		if emailErr != nil {
			return Identity{}, emailErr
		}
		return Identity{}, fmt.Errorf("no verified email found on GitHub account")
	}
	name := strings.TrimSpace(user.Name)
	if name == "" {
		name = user.Login
	}
	return Identity{
		Provider:        "github",
		ProviderSubject: strconv.FormatInt(user.ID, 10),
		Email:           email,
		EmailVerified:   emailVerified,
		Name:            name,
		AvatarURL:       user.AvatarURL,
		Username:        user.Login,
		AccessToken:     token.AccessToken,
	}, nil
}

func (GitHubProvider) SupportsLocalPasswordForm() bool { return true }
