-- CreateTable
CREATE TABLE "user_state" (
    "user_name" TEXT NOT NULL,
    "last_seen_activity_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_state_pkey" PRIMARY KEY ("user_name")
);
