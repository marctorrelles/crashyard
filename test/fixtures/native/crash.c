#include <stdio.h>
#include <stdlib.h>

int render_voice(int *voice) {
    return *voice + 1;
}

int main(int argc, char **argv) {
    printf("%d\n", render_voice(argc > 5 ? &argc : NULL));
    return 0;
}
