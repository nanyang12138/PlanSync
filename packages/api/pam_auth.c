/*
 * pam_auth.c — PAM password verifier for PlanSync
 *
 * Usage: echo "<password>" | ./pam_auth <username>
 * Exit:  0 = authenticated, 1 = failed, 2 = error
 *
 * Compile: gcc pam_auth.c -lpam -o pam_auth
 */
#include <security/pam_appl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char password[1024];

static int conv_fn(int num_msg, const struct pam_message **msg,
                   struct pam_response **resp, void *appdata_ptr) {
    (void)appdata_ptr;
    *resp = calloc(num_msg, sizeof(struct pam_response));
    if (!*resp) return PAM_BUF_ERR;
    for (int i = 0; i < num_msg; i++) {
        if (msg[i]->msg_style == PAM_PROMPT_ECHO_OFF ||
            msg[i]->msg_style == PAM_PROMPT_ECHO_ON) {
            (*resp)[i].resp = strdup(password);
        }
    }
    return PAM_SUCCESS;
}

int main(int argc, char *argv[]) {
    if (argc != 2) {
        fprintf(stderr, "Usage: echo <password> | %s <username>\n", argv[0]);
        return 2;
    }

    if (!fgets(password, sizeof(password), stdin)) {
        fprintf(stderr, "Failed to read password from stdin\n");
        return 2;
    }
    password[strcspn(password, "\n")] = 0;

    struct pam_conv pam_conv = { conv_fn, NULL };
    pam_handle_t *pamh = NULL;

    if (pam_start("login", argv[1], &pam_conv, &pamh) != PAM_SUCCESS) {
        fprintf(stderr, "pam_start failed\n");
        return 2;
    }

    int result = pam_authenticate(pamh, PAM_SILENT | PAM_DISALLOW_NULL_AUTHTOK);
    pam_end(pamh, result);

    return result == PAM_SUCCESS ? 0 : 1;
}
