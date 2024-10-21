import type { Prisma } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";

import { selectOOOEntries } from "@calcom/app-store/zapier/api/subscriptions/listOOOEntries";
import dayjs from "@calcom/dayjs";
import { sendBookingRedirectNotification } from "@calcom/emails";
import type { GetSubscriberOptions } from "@calcom/features/webhooks/lib/getWebhooks";
import getWebhooks from "@calcom/features/webhooks/lib/getWebhooks";
import type { OOOEntryPayloadType } from "@calcom/features/webhooks/lib/sendPayload";
import sendPayload from "@calcom/features/webhooks/lib/sendPayload";
import { getTranslation } from "@calcom/lib/server";
import prisma from "@calcom/prisma";
import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import type { TrpcSessionUser } from "@calcom/trpc/server/trpc";

import { TRPCError } from "@trpc/server";

import { isAdminForUser } from "./outOfOffice.utils";
import { type TOutOfOfficeInputSchema } from "./outOfOfficeCreateOrUpdate.schema";

type TBookingRedirect = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TOutOfOfficeInputSchema;
};

export const outOfOfficeCreateOrUpdate = async ({ ctx, input }: TBookingRedirect) => {
  const { startDate, endDate } = input.dateRange;
  if (!startDate || !endDate) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "start_date_and_end_date_required" });
  }

  const inputStartTime = dayjs(startDate).startOf("day");
  const inputEndTime = dayjs(endDate).endOf("day");
  const startDateUtc = dayjs.utc(startDate).add(input.offset, "minute");
  const endDateUtc = dayjs.utc(endDate).add(input.offset, "minute");

  // If start date is after end date throw error
  if (inputStartTime.isAfter(inputEndTime)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "start_date_must_be_before_end_date" });
  }

  // If start date is before to today throw error
  if (inputStartTime.isBefore(dayjs().startOf("day").subtract(1, "day"))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "start_date_must_be_in_the_future" });
  }

  let oooUserId = ctx.user.id;
  let oooUserName = ctx.user.username;
  let oooUserEmail = ctx.user.email;
  let oooUserTimeZone = ctx.user.timeZone;
  let oooUserOrgId = ctx.user.organizationId;
  let oooUserFullName = ctx.user.name;

  let isAdmin;
  if (!!input.forUserId) {
    isAdmin = await isAdminForUser(ctx.user.id, input.forUserId);
    if (!isAdmin) {
      throw new TRPCError({ code: "NOT_FOUND", message: "only_admin_can_create_ooo" });
    }
    oooUserId = input.forUserId;
    const oooForUser = await prisma.user.findUnique({
      where: { id: input.forUserId },
      select: { username: true, email: true, timeZone: true, organizationId: true, name: true },
    });
    if (oooForUser) {
      oooUserEmail = oooForUser.email;
      oooUserName = oooForUser.username;
      oooUserFullName = oooForUser.name;
      oooUserTimeZone = oooForUser.timeZone;
      oooUserOrgId = oooForUser.organizationId;
    }
  }

  let toUserId: number | null = null;

  if (input.toTeamUserId) {
    const user = await prisma.user.findUnique({
      where: {
        id: input.toTeamUserId,
        /** You can only redirect OOO for members of teams you belong to */
        teams: {
          some: {
            team: {
              members: {
                some: {
                  userId: oooUserId,
                  accepted: true,
                },
              },
            },
          },
        },
      },
      select: {
        id: true,
      },
    });
    if (!user) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: input.forUserId ? "forward_to_team_member_only" : "user_not_found",
      });
    }
    toUserId = user?.id;
  }

  // Validate if OOO entry for these dates already exists
  const outOfOfficeEntry = await prisma.outOfOfficeEntry.findFirst({
    where: {
      AND: [
        { userId: oooUserId },
        {
          uuid: {
            not: input.uuid ?? "",
          },
        },
        {
          OR: [
            {
              start: {
                lte: endDateUtc.toDate(), //existing start is less than or equal to input end time
              },
              end: {
                gte: startDateUtc.toDate(), //existing end is greater than or equal to input start time
              },
            },
            {
              //existing start is within the new input range
              start: {
                gt: startDateUtc.toDate(),
                lt: endDateUtc.toDate(),
              },
            },
            {
              //existing end is within the new input range
              end: {
                gt: startDateUtc.toDate(),
                lt: endDateUtc.toDate(),
              },
            },
          ],
        },
      ],
    },
  });

  // don't allow overlapping entries
  if (outOfOfficeEntry) {
    throw new TRPCError({ code: "CONFLICT", message: "out_of_office_entry_already_exists" });
  }

  if (!input.reasonId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "reason_id_required" });
  }

  // Prevent infinite redirects but consider time ranges
  const existingOutOfOfficeEntry = await prisma.outOfOfficeEntry.findFirst({
    select: {
      userId: true,
      toUserId: true,
    },
    where: {
      ...(toUserId && { userId: toUserId }),
      toUserId: oooUserId,
      // Check for time overlap or collision
      OR: [
        // Outside of range
        {
          AND: [{ start: { lte: endDateUtc.toDate() } }, { end: { gte: startDateUtc.toDate() } }],
        },
        // Inside of range
        {
          AND: [{ start: { gte: startDateUtc.toDate() } }, { end: { lte: endDateUtc.toDate() } }],
        },
      ],
    },
  });

  // don't allow infinite redirects
  if (existingOutOfOfficeEntry) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: input.forUserId
        ? "ooo_team_redirect_infinite_not_allowed"
        : "booking_redirect_infinite_not_allowed",
    });
  }

  // Get the existing redirected user from existing out of office entry to send that user appropriate email.
  const previousOutOfOfficeEntry = await prisma.outOfOfficeEntry.findUnique({
    where: {
      uuid: input.uuid ?? "",
    },
    select: {
      start: true,
      end: true,
      toUser: {
        select: {
          email: true,
          username: true,
        },
      },
    },
  });

  const createdOrUpdatedOutOfOffice = await prisma.outOfOfficeEntry.upsert({
    where: {
      uuid: input.uuid ?? "",
    },
    create: {
      uuid: uuidv4(),
      start: startDateUtc.startOf("day").toISOString(),
      end: endDateUtc.endOf("day").toISOString(),
      notes: input.notes,
      userId: oooUserId,
      reasonId: input.reasonId,
      toUserId: toUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    update: {
      start: startDateUtc.startOf("day").toISOString(),
      end: endDateUtc.endOf("day").toISOString(),
      notes: input.notes,
      userId: oooUserId,
      reasonId: input.reasonId,
      toUserId: toUserId ? toUserId : null,
    },
  });
  let resultRedirect: Prisma.OutOfOfficeEntryGetPayload<{ select: typeof selectOOOEntries }> | null = null;
  if (createdOrUpdatedOutOfOffice) {
    const findRedirect = await prisma.outOfOfficeEntry.findFirst({
      where: {
        uuid: createdOrUpdatedOutOfOffice.uuid,
      },
      select: selectOOOEntries,
    });
    if (findRedirect) {
      resultRedirect = findRedirect;
    }
  }
  if (!resultRedirect) {
    return;
  }
  const toUser = toUserId
    ? await prisma.user.findFirst({
        where: {
          id: toUserId,
        },
        select: {
          name: true,
          username: true,
          timeZone: true,
          email: true,
        },
      })
    : null;
  const reason = await prisma.outOfOfficeReason.findFirst({
    where: {
      id: input.reasonId,
    },
    select: {
      reason: true,
      emoji: true,
    },
  });
  if (toUserId) {
    // await send email to notify user
    const userToNotify = await prisma.user.findFirst({
      where: {
        id: toUserId,
      },
      select: {
        email: true,
        username: true,
      },
    });
    const t = await getTranslation(ctx.user.locale ?? "en", "common");
    const formattedStartDate = new Intl.DateTimeFormat("en-US").format(
      new Date(createdOrUpdatedOutOfOffice.start)
    );
    const formattedEndDate = new Intl.DateTimeFormat("en-US").format(
      new Date(createdOrUpdatedOutOfOffice.end)
    );

    const existingFormattedStartDate = previousOutOfOfficeEntry
      ? new Intl.DateTimeFormat("en-US").format(new Date(previousOutOfOfficeEntry.start))
      : "";
    const existingFormattedEndDate = previousOutOfOfficeEntry
      ? new Intl.DateTimeFormat("en-US").format(new Date(previousOutOfOfficeEntry.end))
      : "";

    const existingRedirectedUser = previousOutOfOfficeEntry?.toUser
      ? previousOutOfOfficeEntry.toUser
      : undefined;

    // Send cancel email to the old redirect user if it is not same as the current redirect user.
    if (existingRedirectedUser && existingRedirectedUser?.email !== userToNotify?.email) {
      await sendBookingRedirectNotification({
        language: t,
        fromEmail: oooUserEmail,
        eventOwner: oooUserName || oooUserEmail,
        toEmail: existingRedirectedUser.email,
        toName: existingRedirectedUser.username || "",
        dates: `${existingFormattedStartDate} - ${existingFormattedEndDate}`,
        action: "cancel",
      });
    }

    if (userToNotify?.email) {
      // If new redirect user exists and it is same as the old redirect user, then send update email.
      if (
        existingRedirectedUser &&
        existingRedirectedUser.email === userToNotify.email &&
        (formattedStartDate !== existingFormattedStartDate || formattedEndDate !== existingFormattedEndDate)
      ) {
        await sendBookingRedirectNotification({
          language: t,
          fromEmail: oooUserEmail,
          eventOwner: oooUserName || oooUserEmail,
          toEmail: userToNotify.email,
          toName: userToNotify.username || "",
          oldDates: `${existingFormattedStartDate} - ${existingFormattedEndDate}`,
          dates: `${formattedStartDate} - ${formattedEndDate}`,
          action: "update",
        });
        // If new redirect user exists and the previous redirect user didn't existed or the previous redirect user is not same as the new user, then send add email.
      } else if (
        !existingRedirectedUser ||
        (existingRedirectedUser && existingRedirectedUser.email !== userToNotify.email)
      ) {
        await sendBookingRedirectNotification({
          language: t,
          fromEmail: oooUserEmail,
          eventOwner: oooUserName || oooUserEmail,
          toEmail: userToNotify.email,
          toName: userToNotify.username || "",
          dates: `${formattedStartDate} - ${formattedEndDate}`,
          action: "add",
        });
      }
    }
  }

  const memberships = await prisma.membership.findMany({
    where: {
      userId: oooUserId,
      accepted: true,
    },
  });

  const teamIds = memberships.map((membership) => membership.teamId);

  // Send webhook to notify other services
  const subscriberOptions: GetSubscriberOptions = {
    userId: oooUserId,
    teamId: teamIds,
    orgId: oooUserOrgId,
    triggerEvent: WebhookTriggerEvents.OOO_CREATED,
  };

  const subscribers = await getWebhooks(subscriberOptions);

  const payload: OOOEntryPayloadType = {
    oooEntry: {
      id: createdOrUpdatedOutOfOffice.id,
      start: dayjs(createdOrUpdatedOutOfOffice.start)
        .tz(oooUserTimeZone, true)
        .format("YYYY-MM-DDTHH:mm:ssZ"),
      end: dayjs(createdOrUpdatedOutOfOffice.end).tz(oooUserTimeZone, true).format("YYYY-MM-DDTHH:mm:ssZ"),
      createdAt: createdOrUpdatedOutOfOffice.createdAt.toISOString(),
      updatedAt: createdOrUpdatedOutOfOffice.updatedAt.toISOString(),
      notes: createdOrUpdatedOutOfOffice.notes,
      reason: {
        emoji: reason?.emoji,
        reason: reason?.reason,
      },
      reasonId: input.reasonId,
      user: {
        id: oooUserId,
        name: oooUserFullName,
        username: oooUserName,
        email: oooUserEmail,
        timeZone: oooUserTimeZone,
      },
      toUser: toUserId
        ? {
            id: toUserId,
            name: toUser?.name,
            username: toUser?.username,
            email: toUser?.email,
            timeZone: toUser?.timeZone,
          }
        : null,
      uuid: createdOrUpdatedOutOfOffice.uuid,
    },
  };

  await Promise.all(
    subscribers.map(async (subscriber) => {
      sendPayload(
        subscriber.secret,
        WebhookTriggerEvents.OOO_CREATED,
        dayjs().toISOString(),
        {
          appId: subscriber.appId,
          subscriberUrl: subscriber.subscriberUrl,
          payloadTemplate: subscriber.payloadTemplate,
        },
        payload
      );
    })
  );

  return {};
};