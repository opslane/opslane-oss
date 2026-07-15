package minio

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/url"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Client wraps the MinIO SDK client with bucket and endpoint configuration.
type Client struct {
	mc *minio.Client
	// publicMC is a second client pointed at the browser-reachable endpoint.
	// Presigned URLs are generated against this client so the signature matches
	// the Host header the browser sends. If nil, mc is used for presigning.
	publicMC *minio.Client
	bucket   string
}

// New creates a MinIO client. endpoint is the internal URL (e.g. http://minio:9000),
// publicEndpoint is the externally-reachable URL (e.g. http://localhost:9012).
// If publicEndpoint is empty, presigned URLs use the internal endpoint.
func New(endpoint, publicEndpoint, accessKey, secretKey, bucket, region string) (*Client, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("invalid endpoint: %w", err)
	}
	useSSL := u.Scheme == "https"

	mc, err := minio.New(u.Host, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
		Region: region,
	})
	if err != nil {
		return nil, fmt.Errorf("minio client: %w", err)
	}

	c := &Client{mc: mc, bucket: bucket}

	// Create a second client for the public endpoint so presigned URLs
	// are signed against the host the browser will actually use.
	if publicEndpoint != "" {
		pu, err := url.Parse(publicEndpoint)
		if err != nil {
			return nil, fmt.Errorf("invalid public endpoint: %w", err)
		}
		pubSSL := pu.Scheme == "https"
		pubMC, err := minio.New(pu.Host, &minio.Options{
			Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
			Secure: pubSSL,
			Region: region,
		})
		if err != nil {
			return nil, fmt.Errorf("minio public client: %w", err)
		}
		c.publicMC = pubMC
	}

	return c, nil
}

// PresignedPutURL generates a presigned PUT URL for the given object key.
// If a public client is configured, the URL is signed against the public host
// so the browser's Host header matches the signature.
func (c *Client) PresignedPutURL(ctx context.Context, objectKey string, expiry time.Duration) (string, error) {
	client := c.mc
	if c.publicMC != nil {
		client = c.publicMC
	}
	u, err := client.PresignedPutObject(ctx, c.bucket, objectKey, expiry)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// BucketExists checks whether the configured bucket exists and is accessible.
// Works with any S3-compatible backend (MinIO, R2, real S3).
func (c *Client) BucketExists(ctx context.Context) (bool, error) {
	return c.mc.BucketExists(ctx, c.bucket)
}

// PutObject uploads bytes to the bucket under the given object key.
func (c *Client) PutObject(ctx context.Context, objectKey string, data []byte, contentType string) error {
	reader := bytes.NewReader(data)
	_, err := c.mc.PutObject(ctx, c.bucket, objectKey, reader, int64(len(data)), minio.PutObjectOptions{
		ContentType: contentType,
	})
	return err
}

// StatObject returns the size in bytes of the object at objectKey.
func (c *Client) StatObject(ctx context.Context, objectKey string) (int64, error) {
	info, err := c.mc.StatObject(ctx, c.bucket, objectKey, minio.StatObjectOptions{})
	if err != nil {
		return 0, err
	}
	return info.Size, nil
}

// GetObject downloads the object at objectKey and returns its bytes. Callers should
// bound size via StatObject first because this reads the whole object into memory.
func (c *Client) GetObject(ctx context.Context, objectKey string) ([]byte, error) {
	obj, err := c.mc.GetObject(ctx, c.bucket, objectKey, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer obj.Close()
	return io.ReadAll(obj)
}

// PresignedPostPolicy generates a presigned POST form policy for uploading a
// single object with a hard, storage-enforced byte ceiling.
//
// This exists because presigned PUT URLs carry no size condition: S3 signs the
// URL, not a policy document, so a PUT holder can upload arbitrarily many bytes.
// content-length-range is only expressible on a POST policy (#48). The caller
// passes the exact declared size; storage rejects anything larger, so a public
// SDK key cannot be turned into a storage-flood primitive.
//
// Returns the POST URL and the form fields the client must send *before* the
// file field (which must be named "file" and sent last).
func (c *Client) PresignedPostPolicy(ctx context.Context, objectKey, contentType string, maxBytes int64, expiry time.Duration) (string, map[string]string, error) {
	if maxBytes <= 0 {
		return "", nil, fmt.Errorf("maxBytes must be positive, got %d", maxBytes)
	}

	policy := minio.NewPostPolicy()
	if err := policy.SetBucket(c.bucket); err != nil {
		return "", nil, err
	}
	if err := policy.SetKey(objectKey); err != nil {
		return "", nil, err
	}
	if err := policy.SetExpires(time.Now().UTC().Add(expiry)); err != nil {
		return "", nil, err
	}
	if err := policy.SetContentType(contentType); err != nil {
		return "", nil, err
	}
	// The ceiling. Storage — not application code — enforces this.
	if err := policy.SetContentLengthRange(1, maxBytes); err != nil {
		return "", nil, err
	}

	// Sign against the public host when configured, so the browser's Host header
	// matches the signature (same reason as PresignedPutURL).
	client := c.mc
	if c.publicMC != nil {
		client = c.publicMC
	}

	u, formData, err := client.PresignedPostPolicy(ctx, policy)
	if err != nil {
		return "", nil, err
	}
	return u.String(), formData, nil
}

// RemoveObject deletes the object at objectKey.
//
// Deleting a key that does not exist is not an error: retention sweeps are
// idempotent and may re-run over a partially-completed batch (#29).
func (c *Client) RemoveObject(ctx context.Context, objectKey string) error {
	return c.mc.RemoveObject(ctx, c.bucket, objectKey, minio.RemoveObjectOptions{})
}

// RemovePrefix deletes every object below prefix. Retention uses this instead
// of trusting database rows because an upload policy can outlive those rows.
func (c *Client) RemovePrefix(ctx context.Context, prefix string) error {
	objects := c.mc.ListObjects(ctx, c.bucket, minio.ListObjectsOptions{
		Prefix:    prefix,
		Recursive: true,
	})
	for object := range objects {
		if object.Err != nil {
			return object.Err
		}
		if err := c.RemoveObject(ctx, object.Key); err != nil {
			return err
		}
	}
	return nil
}
