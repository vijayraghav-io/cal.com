import { keepPreviousData } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Trans } from "next-i18next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { SetStateAction, Dispatch } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Controller, useForm, useFormState } from "react-hook-form";

import dayjs from "@calcom/dayjs";
import { getLayout } from "@calcom/features/settings/layouts/SettingsLayout";
import { getUserAvatarUrl } from "@calcom/lib/getAvatarUrl";
import { useCompatSearchParams } from "@calcom/lib/hooks/useCompatSearchParams";
import { useHasTeamPlan } from "@calcom/lib/hooks/useHasPaidPlan";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { MembershipRole } from "@calcom/prisma/client";
import { trpc } from "@calcom/trpc/react";
import useMeQuery from "@calcom/trpc/react/hooks/useMeQuery";
import {
  Avatar,
  Button,
  DataTable,
  DateRangePicker,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyScreen,
  Icon,
  Meta,
  Select,
  showToast,
  SkeletonText,
  Switch,
  TextArea,
  ToggleGroup,
  UpgradeTeamsBadge,
} from "@calcom/ui";

import PageWrapper from "@components/PageWrapper";

export type BookingRedirectForm = {
  uuid: string | null;
  forUserId: number | null;
  dateRange: { startDate: Date; endDate: Date };
  offset: number;
  toTeamUserId: number | null;
  reasonId: number;
  notes?: string;
};

const CreateOutOfOfficeEntryModal = ({
  openModal,
  closeModal,
  oooType,
  oooEntryToEdit,
  setTeamOOOEntriesUpdated,
  setMyOOOEntriesUpdated,
}: {
  openModal: boolean;
  closeModal: () => void;
  oooType: string;
  oooEntryToEdit: OutOfOfficeEntry | null;
  setTeamOOOEntriesUpdated: Dispatch<SetStateAction<number>>;
  setMyOOOEntriesUpdated: Dispatch<SetStateAction<number>>;
}) => {
  const { t } = useLocale();
  const utils = trpc.useUtils();

  const [selectedReason, setSelectedReason] = useState<{ label: string; value: number } | null>(null);
  const [profileRedirect, setProfileRedirect] = useState(false);
  const [selectedMember, setSelectedMember] = useState<{ label: string; value: number | null } | null>(null);
  const [oooForMember, setOOOForMember] = useState<{ label: string; value: number | null } | null>(null);
  const [dateRange] = useState<{ startDate: Date; endDate: Date }>({
    startDate: dayjs().utc().startOf("d").toDate(),
    endDate: dayjs().utc().add(1, "d").endOf("d").toDate(),
  });

  const { hasTeamPlan } = useHasTeamPlan();
  const { data: listMembers } = trpc.viewer.teams.listMembers.useQuery({});
  const me = useMeQuery();
  const memberListOptions: {
    value: number | null;
    label: string;
  }[] =
    listMembers
      ?.filter((member) => (oooType === "mine" ? me?.data?.id !== member.id : oooType === "team"))
      .map((member) => ({
        value: member.id || null,
        label: member.name || "",
      })) || [];
  const oooForMemberListOptions: {
    value: number | null;
    label: string;
  }[] =
    listMembers
      ?.filter((member) => me?.data?.id !== member.id)
      .map((member) => ({
        value: member.id || null,
        label: member.name || "",
      })) || [];

  const { handleSubmit, setValue, control, register } = useForm<BookingRedirectForm>({
    defaultValues: {
      uuid: null,
      forUserId: null,
      dateRange: {
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      },
      offset: dayjs().utcOffset(),
      toTeamUserId: null,
      reasonId: 1,
    },
  });

  const createOutOfOfficeEntry = trpc.viewer.outOfOfficeCreateOrUpdate.useMutation({
    onSuccess: () => {
      showToast(oooEntryToEdit?.uuid ? t("success_entry_updated") : t("success_entry_created"), "success");
      oooType === "team"
        ? setTeamOOOEntriesUpdated((previousValue) => previousValue + 1)
        : setMyOOOEntriesUpdated((previousValue) => previousValue + 1);
      setProfileRedirect(false);
      closeModal();
    },
    onError: (error) => {
      showToast(t(error.message), "error");
    },
  });

  const { data: outOfOfficeReasonList } = trpc.viewer.outOfOfficeReasonList.useQuery();
  const reasonList = [
    ...(outOfOfficeReasonList || []).map((reason) => ({
      label: `${reason.emoji} ${reason.userId === null ? t(reason.reason) : reason.reason}`,
      value: reason.id,
    })),
  ];

  useEffect(() => {
    setOOOForMember(memberListOptions.find((member) => member.value === oooEntryToEdit?.user?.id) || null);
    setSelectedReason(reasonList.find((reason) => reason.value === oooEntryToEdit?.reason?.id) || null);
    setSelectedMember(memberListOptions.find((member) => member.value === oooEntryToEdit?.toUserId) || null);
    setProfileRedirect(Boolean(oooEntryToEdit?.toUserId));

    setValue("uuid", oooEntryToEdit?.uuid ?? null);
    setValue("forUserId", oooEntryToEdit?.user?.id ?? null);
    setValue("dateRange", {
      startDate: !!oooEntryToEdit
        ? dayjs.utc(oooEntryToEdit.start).subtract(dayjs().utcOffset(), "minutes").toDate()
        : dayjs().utc().startOf("d").toDate(),
      endDate: !!oooEntryToEdit
        ? dayjs.utc(oooEntryToEdit.end).subtract(dayjs().utcOffset(), "minutes").toDate()
        : dayjs().utc().add(1, "d").endOf("d").toDate(),
    });
    setValue("reasonId", oooEntryToEdit?.reason?.id || 1);
    setValue("notes", oooEntryToEdit?.notes ?? "");
    setValue("toTeamUserId", oooEntryToEdit?.toUserId ?? null);
  }, [oooEntryToEdit]);

  return (
    <Dialog open={openModal}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}>
        <form
          id="create-ooo-form"
          className="h-full"
          onSubmit={handleSubmit((data) => {
            createOutOfOfficeEntry.mutate(data);
            if (!oooEntryToEdit) {
              setValue("forUserId", null);
              setValue("toTeamUserId", null);
              setValue("notes", "");
              setValue("dateRange", dateRange);
              setSelectedReason(null);
              setSelectedMember(null);
              setOOOForMember(null);
            }
          })}>
          <div className="px-1">
            <DialogHeader
              title={
                oooType === "team"
                  ? !!oooEntryToEdit
                    ? t("edit_out_of_office")
                    : t("create_ooo_dialog_team_title")
                  : t("create_an_out_of_office")
              }
            />

            {/* In case of Team, Select Member for whom OOO is created */}
            {oooType === "team" && (
              <div className="mb-4 mt-4 h-16">
                <p className="text-emphasis block text-sm font-medium">{t("create_ooo_team_label")}</p>
                <Select
                  className="mt-1 h-4 text-white"
                  name="oooForUsername"
                  data-testid="oooFor_username_select"
                  value={oooForMember}
                  placeholder={t("select_team_member")}
                  isSearchable
                  options={oooForMemberListOptions}
                  onChange={(selectedOption) => {
                    if (selectedOption?.value) {
                      setOOOForMember(selectedOption);
                      setValue("forUserId", selectedOption?.value);
                    }
                  }}
                  isDisabled={!!oooEntryToEdit}
                />
              </div>
            )}

            <div>
              <p className="text-emphasis mb-1 block text-sm font-medium capitalize">{t("dates")}</p>
              <div>
                <Controller
                  name="dateRange"
                  control={control}
                  defaultValue={dateRange}
                  render={({ field: { onChange, value } }) => (
                    <DateRangePicker
                      dates={{ startDate: value.startDate, endDate: value.endDate }}
                      onDatesChange={(values) => {
                        onChange(values);
                      }}
                    />
                  )}
                />
              </div>
            </div>

            {/* Reason Select */}
            <div className="mt-4 w-full">
              <div className="">
                <p className="text-emphasis block text-sm font-medium">{t("reason")}</p>
                <Select
                  className="mb-0 mt-1 text-white"
                  name="reason"
                  data-testid="reason_select"
                  value={selectedReason}
                  placeholder={t("ooo_select_reason")}
                  options={reasonList}
                  onChange={(selectedOption) => {
                    if (selectedOption?.value) {
                      setSelectedReason(selectedOption);
                      setValue("reasonId", selectedOption?.value);
                    }
                  }}
                />
              </div>
            </div>

            {/* Notes input */}
            <div className="mt-4">
              <p className="text-emphasis block text-sm font-medium">{t("notes")}</p>
              <TextArea
                data-testid="notes_input"
                className="border-subtle mt-1 h-10 w-full rounded-lg border px-2"
                placeholder={t("additional_notes")}
                {...register("notes")}
                onChange={(e) => {
                  setValue("notes", e?.target.value);
                }}
              />
            </div>

            <div className="bg-muted my-4 rounded-xl p-5">
              <div className="flex flex-row">
                <Switch
                  disabled={!hasTeamPlan}
                  data-testid="profile-redirect-switch"
                  checked={profileRedirect}
                  id="profile-redirect-switch"
                  onCheckedChange={(state) => {
                    setProfileRedirect(state);
                    if (!state) {
                      setValue("toTeamUserId", null);
                    }
                  }}
                  label={hasTeamPlan ? t("redirect_team_enabled") : t("redirect_team_disabled")}
                />
                {!hasTeamPlan && (
                  <div className="mx-2" data-testid="upgrade-team-badge">
                    <UpgradeTeamsBadge />
                  </div>
                )}
              </div>

              {profileRedirect && (
                <div className="mt-4">
                  <div className="h-16">
                    <p className="text-emphasis block text-sm font-medium">{t("team_member")}</p>
                    <Select
                      className="mt-1 h-4 text-white"
                      name="toTeamUsername"
                      data-testid="team_username_select"
                      value={selectedMember}
                      placeholder={t("select_team_member")}
                      isSearchable
                      options={memberListOptions.filter((option) => option.value !== oooForMember?.value)}
                      onChange={(selectedOption) => {
                        if (selectedOption?.value) {
                          setSelectedMember(selectedOption);
                          setValue("toTeamUserId", selectedOption?.value);
                        }
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </form>
        <DialogFooter showDivider noSticky>
          <div className="flex">
            <Button color="minimal" type="button" onClick={() => closeModal()} className="mr-1">
              {t("cancel")}
            </Button>
            <Button
              form="create-ooo-form"
              color="primary"
              type="submit"
              disabled={createOutOfOfficeEntry.isPending}
              data-testid="create-entry-ooo-redirect">
              {!!oooEntryToEdit ? t("update") : t("create")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface OutOfOfficeEntry {
  id: number;
  uuid: string;
  start: Date;
  end: Date;
  toUserId: number | null;
  toUser: {
    username: string;
  } | null;
  reason: {
    id: number;
    emoji: string;
    reason: string;
    userId: number;
  } | null;
  notes: string | null;
  user: { id: number; avatarUrl: string; username: string; email: string } | null;
}

const OutOfOfficeEntriesList = ({ myOOOEntriesUpdated }: { myOOOEntriesUpdated: number }) => {
  const { t } = useLocale();
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [deletedEntry, setDeletedEntry] = useState(0);
  const { data, isPending, fetchNextPage, isFetching, refetch } =
    trpc.viewer.outOfOfficeEntriesList.useInfiniteQuery(
      {
        limit: 10,
      },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        placeholderData: keepPreviousData,
      }
    );

  useEffect(() => {
    refetch();
  }, [myOOOEntriesUpdated, deletedEntry, refetch]);

  const totalDBRowCount = data?.pages?.[0]?.meta?.totalRowCount ?? 0;
  //Flatten the array of arrays from the useInfiniteQuery hook
  const flatData = useMemo(
    () => data?.pages?.flatMap((page) => page.rows) ?? [],
    [data]
  ) as OutOfOfficeEntry[];
  const totalFetched = flatData.length;

  const columns: ColumnDef<OutOfOfficeEntry>[] = [
    {
      id: "member",
      cell: ({ row }) => {
        const item = row.original;
        return (
          <>
            {row.original ? (
              <div className="flex flex-row justify-between p-4">
                <div className="flex flex-row items-center">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-50">
                    {item?.reason?.emoji || "🏝️"}
                  </div>

                  <div className="ml-2 flex flex-col">
                    <p className="px-2 font-bold">
                      {dayjs.utc(item.start).format("ll")} - {dayjs.utc(item.end).format("ll")}
                    </p>
                    <p className="px-2">
                      {item.toUser?.username ? (
                        <Trans
                          i18nKey="ooo_forwarding_to"
                          values={{
                            username: item.toUser?.username,
                          }}
                          components={{
                            span: <span className="text-subtle font-bold" />,
                          }}
                        />
                      ) : (
                        <>{t("ooo_not_forwarding")}</>
                      )}
                    </p>
                    {item.notes && (
                      <p className="px-2">
                        <span className="text-subtle">{t("notes")}: </span>
                        {item.notes}
                      </p>
                    )}
                  </div>
                </div>

                <Button
                  className="self-center rounded-lg border"
                  type="button"
                  color="minimal"
                  variant="icon"
                  disabled={deleteOutOfOfficeEntryMutation.isPending}
                  StartIcon="trash-2"
                  onClick={() => {
                    deleteOutOfOfficeEntryMutation.mutate({ outOfOfficeUid: item.uuid });
                  }}
                />
              </div>
            ) : (
              <SkeletonText className="h-8 w-full" />
            )}
          </>
        );
      },
    },
  ];

  if (tableContainerRef.current) {
    tableContainerRef.current.style.height = "736px";
    tableContainerRef.current.style.overflowAnchor = "none";
    tableContainerRef.current.classList.add("overflow-auto");
  }

  //called on scroll to fetch more data as the user scrolls and reaches bottom of table
  const fetchMoreOnBottomReached = useCallback(
    (containerRefElement?: HTMLDivElement | null) => {
      if (containerRefElement) {
        const { scrollHeight, scrollTop, clientHeight } = containerRefElement;
        //once the user has scrolled within 100px of the bottom of the table, fetch more data if there is any
        if (scrollHeight - scrollTop - clientHeight < 100 && !isFetching && totalFetched < totalDBRowCount) {
          fetchNextPage();
        }
        if (isFetching) {
          containerRefElement.classList.add("cursor-wait");
        } else {
          containerRefElement.classList.remove("cursor-wait");
        }
      }
    },
    [fetchNextPage, isFetching, totalFetched, totalDBRowCount]
  );

  useEffect(() => {
    fetchMoreOnBottomReached(tableContainerRef.current);
  }, [fetchMoreOnBottomReached]);

  const deleteOutOfOfficeEntryMutation = trpc.viewer.outOfOfficeEntryDelete.useMutation({
    onSuccess: () => {
      showToast(t("success_deleted_entry_out_of_office"), "success");
      setDeletedEntry((previousValue) => previousValue + 1);
      useFormState;
    },
    onError: () => {
      showToast(`An error ocurred`, "error");
    },
  });

  if (
    data === null ||
    (data?.pages?.length !== 0 && data?.pages[0].meta.totalRowCount === 0) ||
    (data === undefined && !isPending)
  )
    return (
      <EmptyScreen
        className="mt-6"
        headline={t("ooo_empty_title")}
        description={t("ooo_empty_description")}
        customIcon={
          <div className="mt-4 h-[102px]">
            <div className="flex h-full flex-col items-center justify-center p-2 md:mt-0 md:p-0">
              <div className="relative">
                <div className="dark:bg-darkgray-50 absolute -left-3 -top-3 -z-20 h-[70px] w-[70px] -rotate-[24deg] rounded-3xl border-2 border-[#e5e7eb] p-8 opacity-40 dark:opacity-80">
                  <div className="w-12" />
                </div>
                <div className="dark:bg-darkgray-50 absolute -top-3 left-3 -z-10 h-[70px] w-[70px] rotate-[24deg] rounded-3xl border-2 border-[#e5e7eb] p-8 opacity-60 dark:opacity-90">
                  <div className="w-12" />
                </div>
                <div className="dark:bg-darkgray-50 relative z-0 flex h-[70px] w-[70px] items-center justify-center rounded-3xl border-2 border-[#e5e7eb] bg-white">
                  <Icon name="clock" size={28} />
                  <div className="dark:bg-darkgray-50 absolute right-4 top-5 h-[12px] w-[12px] rotate-[56deg] bg-white text-lg font-bold" />
                  <span className="absolute right-4 top-3 font-sans text-sm font-extrabold">z</span>
                </div>
              </div>
            </div>
          </div>
        }
      />
    );
  return (
    <>
      <div>
        <DataTable
          hideHeader={true}
          data-testid="ooo-mine-list-data-table"
          tableContainerRef={tableContainerRef}
          columns={columns}
          data={isPending ? new Array(5).fill(null) : flatData}
          onScroll={(e) => fetchMoreOnBottomReached(e.target as HTMLDivElement)}
        />
      </div>
    </>
  );
};

const OutOfOfficeEntriesListForTeam = ({
  setOpenModal,
  setOOOEntryToEdit,
  teamOOOEntriesUpdated,
}: {
  setOpenModal: Dispatch<SetStateAction<boolean>>;
  setOOOEntryToEdit: Dispatch<SetStateAction<OutOfOfficeEntry | null>>;
  teamOOOEntriesUpdated: number;
}) => {
  const { t } = useLocale();
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [deletedEntry, setDeletedEntry] = useState(0);
  const { data, isPending, fetchNextPage, isFetching, refetch } =
    trpc.viewer.outOfOfficeEntriesList.useInfiniteQuery(
      {
        limit: 10,
        fetchTeamMembersEntries: true,
        searchTerm: debouncedSearchTerm,
      },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        placeholderData: keepPreviousData,
      }
    );

  useEffect(() => {
    refetch();
  }, [teamOOOEntriesUpdated, deletedEntry, refetch]);

  const totalDBRowCount = data?.pages?.[0]?.meta?.totalRowCount ?? 0;
  //Flatten the array of arrays from the useInfiniteQuery hook
  const flatData = useMemo(
    () => data?.pages?.flatMap((page) => page.rows) ?? [],
    [data]
  ) as OutOfOfficeEntry[];
  const totalFetched = flatData.length;

  const columns: ColumnDef<OutOfOfficeEntry>[] = [
    {
      id: "member",
      header: `Member`,
      cell: ({ row }) => {
        if (!row.original || !row.original.user) {
          return <SkeletonText className="h-8 w-full" />;
        }
        const { avatarUrl, username, email } = row.original.user;
        return (
          <div className="flex items-center gap-2">
            <Avatar
              size="sm"
              alt={username || email}
              imageSrc={getUserAvatarUrl({
                avatarUrl,
              })}
            />
            <div className="">
              <div
                data-testid={`member-${username}-username`}
                className="text-emphasis text-sm font-medium leading-none">
                {username || "No username"}
              </div>
              <div data-testid={`member-${username}-email`} className="text-subtle mt-1 text-sm leading-none">
                {email}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      id: "outOfOffice",
      header: `OutOfOffice (${totalDBRowCount})`,
      cell: ({ row }) => {
        const item = row.original;
        return (
          <>
            {row.original ? (
              <div className="flex flex-row items-center pb-2 pt-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-50">
                  {item?.reason?.emoji || "🏝️"}
                </div>

                <div className="ml-2 flex flex-col">
                  <p className="px-2 font-bold">
                    {dayjs.utc(item.start).format("ll")} - {dayjs.utc(item.end).format("ll")}
                  </p>
                  <p className="px-2">
                    {item.toUser?.username ? (
                      <Trans
                        i18nKey="ooo_forwarding_to"
                        values={{
                          username: item.toUser?.username,
                        }}
                        components={{
                          span: <span className="text-subtle font-bold" />,
                        }}
                      />
                    ) : (
                      <>{t("ooo_not_forwarding")}</>
                    )}
                  </p>
                  {item.notes && (
                    <p className="px-2">
                      <span className="text-subtle">{t("notes")}: </span>
                      {item.notes}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <SkeletonText className="h-8 w-full" />
            )}
          </>
        );
      },
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const oooEntry = row.original;
        return (
          <>
            {row.original ? (
              <div className="flex items-center gap-2">
                <Button
                  className="self-center rounded-lg border"
                  type="button"
                  color="minimal"
                  variant="icon"
                  disabled={deleteOutOfOfficeEntryMutation.isPending}
                  StartIcon="pencil"
                  onClick={() => {
                    setOOOEntryToEdit(oooEntry);
                    setOpenModal(true);
                  }}
                />
                <Button
                  className="self-center rounded-lg border"
                  type="button"
                  color="minimal"
                  variant="icon"
                  disabled={deleteOutOfOfficeEntryMutation.isPending}
                  StartIcon="trash-2"
                  onClick={() => {
                    deleteOutOfOfficeEntryMutation.mutate({ outOfOfficeUid: oooEntry.uuid });
                  }}
                />
              </div>
            ) : (
              <SkeletonText className="h-8 w-full" />
            )}
          </>
        );
      },
    },
  ];

  if (tableContainerRef.current) {
    tableContainerRef.current.style.height = "736px";
    tableContainerRef.current.style.overflowAnchor = "none";
    tableContainerRef.current.classList.add("overflow-auto");
  }

  //called on scroll to fetch more data as the user scrolls and reaches bottom of table
  const fetchMoreOnBottomReached = useCallback(
    (containerRefElement?: HTMLDivElement | null) => {
      if (containerRefElement) {
        const { scrollHeight, scrollTop, clientHeight } = containerRefElement;
        //once the user has scrolled within 100px of the bottom of the table, fetch more data if there is any
        if (scrollHeight - scrollTop - clientHeight < 100 && !isFetching && totalFetched < totalDBRowCount) {
          fetchNextPage();
        }
        if (isFetching) {
          containerRefElement.classList.add("cursor-wait");
        } else {
          containerRefElement.classList.remove("cursor-wait");
        }
      }
    },
    [fetchNextPage, isFetching, totalFetched, totalDBRowCount]
  );

  useEffect(() => {
    fetchMoreOnBottomReached(tableContainerRef.current);
  }, [fetchMoreOnBottomReached]);

  const deleteOutOfOfficeEntryMutation = trpc.viewer.outOfOfficeEntryDelete.useMutation({
    onSuccess: () => {
      showToast(t("success_deleted_entry_out_of_office"), "success");
      setDeletedEntry((previousValue) => previousValue + 1);
      useFormState;
    },
    onError: () => {
      showToast(`An error ocurred`, "error");
    },
  });

  if (
    data === null ||
    (data?.pages?.length === 0 && data?.pages[0].meta.totalRowCount === 0 && debouncedSearchTerm === "") ||
    (data === undefined && !isPending)
  )
    return (
      <EmptyScreen
        className="mt-6"
        headline={t("ooo_team_empty_title")}
        description={t("ooo_team_empty_description")}
        customIcon={
          <div className="mt-4 h-[102px]">
            <div className="flex h-full flex-col items-center justify-center p-2 md:mt-0 md:p-0">
              <div className="relative">
                <div className="dark:bg-darkgray-50 absolute -left-3 -top-3 -z-20 h-[70px] w-[70px] -rotate-[24deg] rounded-3xl border-2 border-[#e5e7eb] p-8 opacity-40 dark:opacity-80">
                  <div className="w-12" />
                </div>
                <div className="dark:bg-darkgray-50 absolute -top-3 left-3 -z-10 h-[70px] w-[70px] rotate-[24deg] rounded-3xl border-2 border-[#e5e7eb] p-8 opacity-60 dark:opacity-90">
                  <div className="w-12" />
                </div>
                <div className="dark:bg-darkgray-50 relative z-0 flex h-[70px] w-[70px] items-center justify-center rounded-3xl border-2 border-[#e5e7eb] bg-white">
                  <Icon name="clock" size={28} />
                  <div className="dark:bg-darkgray-50 absolute right-4 top-5 h-[12px] w-[12px] rotate-[56deg] bg-white text-lg font-bold" />
                  <span className="absolute right-4 top-3 font-sans text-sm font-extrabold">z</span>
                </div>
              </div>
            </div>
          </div>
        }
      />
    );
  return (
    <>
      <div>
        <DataTable
          data-testid="ooo-mine-list-data-table"
          onSearch={(value) => setDebouncedSearchTerm(value)}
          tableContainerRef={tableContainerRef}
          columns={columns}
          data={isPending ? new Array(5).fill(null) : flatData}
          onScroll={(e) => fetchMoreOnBottomReached(e.target as HTMLDivElement)}
        />
      </div>
    </>
  );
};

const OutOfOfficePage = () => {
  const { t } = useLocale();
  const params = useSearchParams();
  const searchParams = useCompatSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const openModalOnStart = !!params?.get("om");
  useEffect(() => {
    if (openModalOnStart) {
      setOpenModal(true);
    }
  }, [openModalOnStart]);

  // Get a new searchParams string by merging the current searchParams with a provided key/value pair
  const createQueryString = useCallback(
    (name: string, value: string) => {
      const params = new URLSearchParams(searchParams ?? undefined);
      params.set(name, value);

      return params.toString();
    },
    [searchParams]
  );

  const [openModal, setOpenModal] = useState(false);
  const [oooType, setOOOType] = useState(searchParams?.get("type") ?? "mine");
  const [oooEntryToEdit, setOOOEntryToEdit] = useState<OutOfOfficeEntry | null>(null);
  const [myOOOEntriesUpdated, setMyOOOEntriesUpdated] = useState(0);
  const [teamOOOEntriesUpdated, setTeamOOOEntriesUpdated] = useState(0);

  const { isPending } = trpc.viewer.outOfOfficeReasonList.useQuery();
  const { data } = trpc.viewer.organizations.listCurrent.useQuery();

  const isOrgAdminOrOwner =
    data && (data.user.role === MembershipRole.OWNER || data.user.role === MembershipRole.ADMIN);
  const isOrgAndPrivate = data?.isOrganization && data.isPrivate;
  const toggleGroupOptions = [{ value: "mine", label: t("my_ooo") }];
  if (!isOrgAndPrivate || isOrgAdminOrOwner) {
    toggleGroupOptions.push({ value: "team", label: t("team_ooo") });
  }

  return (
    <>
      <Meta
        title={t("out_of_office")}
        description={
          oooType === "mine" ? t("out_of_office_description") : t("out_of_office_team_description")
        }
        borderInShellHeader={false}
        CTA={
          <div className="flex gap-2">
            <ToggleGroup
              className="hidden md:block"
              defaultValue={oooType}
              onValueChange={(value) => {
                if (!value) return;
                router.push(`${pathname}?${createQueryString("type", value)}`);
                setOOOType(value);
              }}
              options={toggleGroupOptions}
            />
            {isPending ? (
              <SkeletonText className="h-8 w-20" />
            ) : (
              <Button
                color="primary"
                className="flex w-20 items-center justify-between px-4"
                onClick={() => setOpenModal(true)}
                data-testid="add_entry_ooo">
                <Icon name="plus" size={16} /> {t("add")}
              </Button>
            )}
          </div>
        }
      />
      <CreateOutOfOfficeEntryModal
        openModal={openModal}
        closeModal={() => {
          setOOOEntryToEdit(null);
          setOpenModal(false);
        }}
        oooType={oooType}
        oooEntryToEdit={oooEntryToEdit}
        setTeamOOOEntriesUpdated={setTeamOOOEntriesUpdated}
        setMyOOOEntriesUpdated={setMyOOOEntriesUpdated}
      />
      {oooType === "team" ? (
        <OutOfOfficeEntriesListForTeam
          setOpenModal={setOpenModal}
          setOOOEntryToEdit={setOOOEntryToEdit}
          teamOOOEntriesUpdated={teamOOOEntriesUpdated}
        />
      ) : (
        <OutOfOfficeEntriesList myOOOEntriesUpdated={myOOOEntriesUpdated} />
      )}
    </>
  );
};

OutOfOfficePage.getLayout = getLayout;
OutOfOfficePage.PageWrapper = PageWrapper;

export default OutOfOfficePage;
