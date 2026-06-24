CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

CREATE TABLE "signing_keys" (
    "kid" TEXT NOT NULL,
    "alg" TEXT NOT NULL DEFAULT 'RS256',
    "private_jwk" TEXT NOT NULL,
    "public_jwk" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'current',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "signing_keys_pkey" PRIMARY KEY ("kid")
);
