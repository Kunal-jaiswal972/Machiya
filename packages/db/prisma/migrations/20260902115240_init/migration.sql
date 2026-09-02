-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SEEKER', 'LISTER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ListingType" AS ENUM ('RENT', 'SALE');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'PAUSED', 'RENTED');

-- CreateEnum
CREATE TYPE "FurnishingType" AS ENUM ('UNFURNISHED', 'SEMI_FURNISHED', 'FULLY_FURNISHED');

-- CreateEnum
CREATE TYPE "PropertyType" AS ENUM ('APARTMENT', 'INDEPENDENT_HOUSE', 'BUILDER_FLOOR', 'VILLA', 'STUDIO', 'PENTHOUSE', 'PG');

-- CreateEnum
CREATE TYPE "EnquiryStatus" AS ENUM ('OPEN', 'RESPONDED', 'CLOSED', 'SPAM');

-- CreateEnum
CREATE TYPE "FuelType" AS ENUM ('PETROL', 'DIESEL', 'CNG');

-- CreateTable
CREATE TABLE "City" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "centroidLat" DOUBLE PRECISION NOT NULL,
    "centroidLng" DOUBLE PRECISION NOT NULL,
    "bbox" JSONB NOT NULL,
    "defaultFuelType" "FuelType" NOT NULL DEFAULT 'PETROL',
    "transitFareConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'SEEKER',
    "phone" TEXT,
    "isPhoneVerified" BOOLEAN NOT NULL DEFAULT false,
    "banned" BOOLEAN,
    "banReason" TEXT,
    "banExpires" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficeLocation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "location" geography(Point, 4326),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficeLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "listingType" "ListingType" NOT NULL,
    "propertyType" "PropertyType" NOT NULL,
    "status" "ListingStatus" NOT NULL DEFAULT 'DRAFT',
    "address" TEXT NOT NULL,
    "locality" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "location" geography(Point, 4326),
    "bedrooms" INTEGER NOT NULL,
    "bathrooms" INTEGER NOT NULL,
    "floor" INTEGER,
    "totalFloors" INTEGER,
    "areaSqft" INTEGER NOT NULL,
    "furnishing" "FurnishingType" NOT NULL,
    "rentAmount" INTEGER,
    "salePrice" INTEGER,
    "securityDeposit" INTEGER,
    "maintenanceMonthly" INTEGER,
    "availableFrom" TIMESTAMP(3),
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "rules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingImage" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isCover" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Amenity" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "category" TEXT NOT NULL,

    CONSTRAINT "Amenity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingAmenity" (
    "listingId" TEXT NOT NULL,
    "amenityId" TEXT NOT NULL,

    CONSTRAINT "ListingAmenity_pkey" PRIMARY KEY ("listingId","amenityId")
);

-- CreateTable
CREATE TABLE "Enquiry" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "seekerId" TEXT NOT NULL,
    "listerId" TEXT NOT NULL,
    "status" "EnquiryStatus" NOT NULL DEFAULT 'OPEN',
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Enquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnquiryMessage" (
    "id" TEXT NOT NULL,
    "enquiryId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnquiryMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Favorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedSearch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "officeLat" DOUBLE PRECISION NOT NULL,
    "officeLng" DOUBLE PRECISION NOT NULL,
    "radiusMeters" INTEGER NOT NULL DEFAULT 3000,
    "notifyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedSearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FuelPrice" (
    "id" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "fuelType" "FuelType" NOT NULL,
    "price" DECIMAL(8,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "source" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FuelPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingView" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "userId" TEXT,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "City_slug_key" ON "City"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "OfficeLocation_userId_idx" ON "OfficeLocation"("userId");

-- CreateIndex
CREATE INDEX "OfficeLocation_userId_isDefault_idx" ON "OfficeLocation"("userId", "isDefault");

-- CreateIndex
CREATE INDEX "office_location_gix" ON "OfficeLocation" USING GIST ("location");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_slug_key" ON "Listing"("slug");

-- CreateIndex
CREATE INDEX "Listing_cityId_idx" ON "Listing"("cityId");

-- CreateIndex
CREATE INDEX "Listing_ownerId_idx" ON "Listing"("ownerId");

-- CreateIndex
CREATE INDEX "Listing_cityId_status_listingType_idx" ON "Listing"("cityId", "status", "listingType");

-- CreateIndex
CREATE INDEX "Listing_status_rentAmount_idx" ON "Listing"("status", "rentAmount");

-- CreateIndex
CREATE INDEX "Listing_ownerId_status_idx" ON "Listing"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Listing_status_publishedAt_idx" ON "Listing"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "Listing_title_idx" ON "Listing" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Listing_address_idx" ON "Listing" USING GIN ("address" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "listing_location_gix" ON "Listing" USING GIST ("location");

-- CreateIndex
CREATE INDEX "ListingImage_listingId_idx" ON "ListingImage"("listingId");

-- CreateIndex
CREATE INDEX "ListingImage_listingId_sortOrder_idx" ON "ListingImage"("listingId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Amenity_slug_key" ON "Amenity"("slug");

-- CreateIndex
CREATE INDEX "Amenity_category_idx" ON "Amenity"("category");

-- CreateIndex
CREATE INDEX "ListingAmenity_amenityId_idx" ON "ListingAmenity"("amenityId");

-- CreateIndex
CREATE INDEX "Enquiry_listingId_idx" ON "Enquiry"("listingId");

-- CreateIndex
CREATE INDEX "Enquiry_seekerId_idx" ON "Enquiry"("seekerId");

-- CreateIndex
CREATE INDEX "Enquiry_listerId_idx" ON "Enquiry"("listerId");

-- CreateIndex
CREATE INDEX "Enquiry_listerId_status_lastMessageAt_idx" ON "Enquiry"("listerId", "status", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "Enquiry_listingId_seekerId_key" ON "Enquiry"("listingId", "seekerId");

-- CreateIndex
CREATE INDEX "EnquiryMessage_enquiryId_idx" ON "EnquiryMessage"("enquiryId");

-- CreateIndex
CREATE INDEX "EnquiryMessage_senderId_idx" ON "EnquiryMessage"("senderId");

-- CreateIndex
CREATE INDEX "EnquiryMessage_enquiryId_createdAt_idx" ON "EnquiryMessage"("enquiryId", "createdAt");

-- CreateIndex
CREATE INDEX "Favorite_userId_idx" ON "Favorite"("userId");

-- CreateIndex
CREATE INDEX "Favorite_listingId_idx" ON "Favorite"("listingId");

-- CreateIndex
CREATE UNIQUE INDEX "Favorite_userId_listingId_key" ON "Favorite"("userId", "listingId");

-- CreateIndex
CREATE INDEX "SavedSearch_userId_idx" ON "SavedSearch"("userId");

-- CreateIndex
CREATE INDEX "SavedSearch_notifyEnabled_idx" ON "SavedSearch"("notifyEnabled");

-- CreateIndex
CREATE INDEX "FuelPrice_cityId_idx" ON "FuelPrice"("cityId");

-- CreateIndex
CREATE INDEX "FuelPrice_cityId_fuelType_fetchedAt_idx" ON "FuelPrice"("cityId", "fuelType", "fetchedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "FuelPrice_cityId_fuelType_fetchedAt_key" ON "FuelPrice"("cityId", "fuelType", "fetchedAt");

-- CreateIndex
CREATE INDEX "ListingView_listingId_idx" ON "ListingView"("listingId");

-- CreateIndex
CREATE INDEX "ListingView_userId_idx" ON "ListingView"("userId");

-- CreateIndex
CREATE INDEX "ListingView_listingId_viewedAt_idx" ON "ListingView"("listingId", "viewedAt");

-- AddForeignKey
ALTER TABLE "OfficeLocation" ADD CONSTRAINT "OfficeLocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingImage" ADD CONSTRAINT "ListingImage_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingAmenity" ADD CONSTRAINT "ListingAmenity_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingAmenity" ADD CONSTRAINT "ListingAmenity_amenityId_fkey" FOREIGN KEY ("amenityId") REFERENCES "Amenity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enquiry" ADD CONSTRAINT "Enquiry_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enquiry" ADD CONSTRAINT "Enquiry_seekerId_fkey" FOREIGN KEY ("seekerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enquiry" ADD CONSTRAINT "Enquiry_listerId_fkey" FOREIGN KEY ("listerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnquiryMessage" ADD CONSTRAINT "EnquiryMessage_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "Enquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnquiryMessage" ADD CONSTRAINT "EnquiryMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedSearch" ADD CONSTRAINT "SavedSearch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelPrice" ADD CONSTRAINT "FuelPrice_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingView" ADD CONSTRAINT "ListingView_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingView" ADD CONSTRAINT "ListingView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
